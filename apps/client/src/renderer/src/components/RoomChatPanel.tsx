import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ChatMessageDTO } from "@r3dvoice/shared";
import { ApiClient } from "../lib/api.js";
import { ensureTransport, setCurrentlyViewingThread, type ChatTransport } from "../lib/chat-transport.js";
import { useAuthStore } from "../lib/auth-context.js";
import { decryptDM, encryptDM, type EncryptedDMPayload } from "../lib/crypto.js";
import { loadKeyPair } from "../lib/key-storage.js";
import { I } from "./Icons.js";
import { MentionAutocomplete } from "./MentionAutocomplete.js";

interface Props {
  threadType: "room" | "dm";
  threadId: string;
  localIdentity: string;
  localName: string;
  onClose(): void;
  mentionCandidates?: { id: string; handle: string; displayName: string }[];
}

// Persistent chat panel backed by REST + WebSocket (P5 T20).
// LiveKit DataChannel is no longer the transport — every message round-trips
// through the server so it shows up in the user's history regardless of
// whether they were online when sent.
export function RoomChatPanel({
  threadType,
  threadId,
  localIdentity,
  localName,
  onClose,
  mentionCandidates = [],
}: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);

  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const apiRef = useRef<ApiClient | null>(null);
  const transportRef = useRef<ChatTransport | null>(null);

  // E2EE state — only relevant for DMs.
  const myKeyPair = useMemo(() => (threadType === "dm" ? loadKeyPair() : null), [threadType]);
  const [peerPublicKey, setPeerPublicKey] = useState<string | null>(null);
  const peerUserId = useMemo(() => {
    if (threadType !== "dm") return null;
    const parts = threadId.split(":");
    if (parts.length !== 2) return null;
    return parts[0] === localIdentity ? parts[1] ?? null : parts[0] ?? null;
  }, [threadType, threadId, localIdentity]);

  // Build a thread-scoped API + transport. Re-initialized when the
  // thread/server/token changes.
  useEffect(() => {
    if (!token) return;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    apiRef.current = api;

    // Use the app-wide singleton transport — established at login. Without
    // it WS-targeted events (mentions, friend events, presence) silently
    // drop whenever no chat panel is mounted.
    const transport = ensureTransport(serverUrl, token);
    transportRef.current = transport;
    setCurrentlyViewingThread({ threadType, threadId });

    let cancelled = false;
    void api
      .chatHistory(threadType, threadId, { limit: 50 })
      .then((res) => {
        if (!cancelled) setMessages(res.messages);
      })
      .catch((e: Error) => {
        if (!cancelled) setError(e.message);
      });

    // For DMs, also fetch the peer's public key so we can encrypt outgoing
    // messages. Decryption only needs the sender's pubkey (embedded in each
    // ciphertext envelope) + our secret — fetching the peer is purely for
    // sending.
    if (threadType === "dm" && peerUserId) {
      void api
        .getUserPublicKey(peerUserId)
        .then((res) => {
          if (!cancelled) setPeerPublicKey(res.publicKey);
        })
        .catch(() => {
          if (!cancelled) setPeerPublicKey(null);
        });
    }

    const off = transport.on((event) => {
      if (event.type === "message") {
        if (event.message.threadType === threadType && event.message.threadId === threadId) {
          setMessages((prev) => [...prev, event.message]);
        }
      } else if (event.type === "edited") {
        if (event.message.threadType === threadType && event.message.threadId === threadId) {
          setMessages((prev) => prev.map((m) => (m.id === event.message.id ? event.message : m)));
        }
      } else if (event.type === "deleted") {
        if (event.threadType === threadType && event.threadId === threadId) {
          setMessages((prev) =>
            prev.map((m) => (m.id === event.id ? { ...m, body: null, deletedAt: new Date().toISOString() } : m)),
          );
        }
      }
    });

    // Singleton is already started by App.tsx; just subscribe to this thread.
    transport.subscribe(threadType, threadId);

    return () => {
      cancelled = true;
      off();
      transport.unsubscribe(threadType, threadId);
      // Don't stop the transport — it lives for the whole logged-in session.
      setCurrentlyViewingThread(null);
      apiRef.current = null;
      transportRef.current = null;
    };
  }, [serverUrl, token, threadType, threadId]);

  // Auto-scroll on new message (only if user is near the bottom).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

  const send = async (): Promise<void> => {
    const text = draft.trim();
    if (!text || !apiRef.current) return;

    // For DMs, we need both keys before we can encrypt. If they're missing,
    // surface an error rather than silently send plaintext.
    let body = text;
    if (threadType === "dm") {
      if (!myKeyPair) {
        setError("Your encryption keypair is missing on this device. Restore your key backup from the login screen.");
        return;
      }
      if (!peerPublicKey) {
        setError("This user hasn't enrolled an encryption key yet — DMs require the recipient to be on a recent client.");
        return;
      }
      const envelope = encryptDM(text, peerPublicKey, myKeyPair);
      body = JSON.stringify(envelope);
    }

    setDraft("");
    setEmojiOpen(false);
    setError(null);
    inputRef.current?.focus();
    try {
      // The server broadcasts back over WS so we'll see our own message arrive
      // there. No local echo needed.
      await apiRef.current.chatSend({ threadType, threadId, body });
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
      // Restore draft so the user doesn't lose their text on a network blip.
      setDraft(text);
    }
  };

  // Display-side decryption: walks every DM message and replaces its body
  // with the decrypted plaintext (or a placeholder when decryption fails).
  // Memoized so re-renders don't redo the work on the same ciphertext.
  const decrypted = useMemo<ChatMessageDTO[]>(() => {
    if (threadType !== "dm") return messages;
    return messages.map((m) => {
      if (m.body === null) return m; // already deleted
      if (!myKeyPair) return { ...m, body: "(encrypted — restore your key)" };
      let payload: EncryptedDMPayload;
      try {
        payload = JSON.parse(m.body) as EncryptedDMPayload;
      } catch {
        return m; // legacy plaintext, fall through
      }
      if (typeof payload !== "object" || payload === null || payload.v !== 1) return m;
      const plain = decryptDM(payload, myKeyPair);
      if (plain === null) return { ...m, body: "(can't decrypt)" };
      return { ...m, body: plain };
    });
  }, [messages, threadType, myKeyPair]);

  const insertEmoji = (e: string): void => {
    setDraft((d) => d + e);
    inputRef.current?.focus();
  };

  const onPickMention = (c: { id: string; handle: string; displayName: string }): void => {
    if (mentionQuery === null) return;
    const before = draft.slice(0, mentionAnchor);
    const after = draft.slice(mentionAnchor + 1 + mentionQuery.length);
    setDraft(`${before}@${c.handle} ${after}`);
    setMentionQuery(null);
    inputRef.current?.focus();
  };

  // Reference localIdentity/localName for "you" styling without warnings; both
  // come from props but we don't need them after the rewrite. Keep around for
  // future per-author UI tweaks.
  void localIdentity;
  void localName;

  return (
    <aside
      style={{
        position: "absolute",
        top: 0,
        right: 0,
        bottom: 0,
        width: 320,
        zIndex: 40,
        background: "color-mix(in oklch, var(--rv-ink-0) 92%, transparent)",
        borderLeft: "1px solid var(--border-soft)",
        backdropFilter: "blur(10px)",
        display: "grid",
        gridTemplateRows: "auto 1fr auto",
        animation: "rv-fade var(--d-mid) var(--ease-out) both",
      }}
    >
      <header
        style={{
          padding: "var(--s-3) var(--s-4)",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          <I.Chat size={14} />
          <span className="rv-label">Room chat</span>
          <span
            className="rv-mono"
            style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}
          >
            ephemeral
          </span>
        </div>
        <button
          type="button"
          className="rv-btn rv-btn-icon"
          data-variant="ghost"
          onClick={onClose}
          aria-label="Close chat"
        >
          <I.X size={14} />
        </button>
      </header>

      <div
        ref={listRef}
        className="rv-scroll"
        style={{
          padding: "var(--s-4)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
        }}
      >
        {decrypted.length === 0 ? (
          <div
            style={{
              color: "var(--text-faint)",
              fontSize: "var(--t-xs)",
              textAlign: "center",
              padding: "var(--s-5) 0",
              lineHeight: 1.5,
            }}
          >
            No messages yet.
          </div>
        ) : (
          decrypted.map((m) => <ChatBubble key={m.id} msg={m} />)
        )}
        {error && (
          <div
            style={{
              color: "var(--accent-glow)",
              fontSize: "var(--t-xs)",
              padding: "var(--s-2) var(--s-3)",
              border: "1px solid color-mix(in oklch, var(--accent) 40%, transparent)",
              borderRadius: "var(--r-sm)",
              background: "color-mix(in oklch, var(--accent) 8%, var(--bg-elev-2))",
            }}
          >
            {error}
          </div>
        )}
      </div>

      <footer
        style={{
          padding: "var(--s-3) var(--s-4)",
          borderTop: "1px solid var(--border-soft)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-2)",
          position: "relative",
        }}
      >
        {emojiOpen && <EmojiPicker onPick={insertEmoji} />}
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <button
            type="button"
            className="rv-btn rv-btn-icon"
            data-variant="ghost"
            onClick={() => setEmojiOpen((o) => !o)}
            aria-label="Emoji"
            data-active={emojiOpen}
          >
            <I.Smile size={16} />
          </button>
          <div style={{ position: "relative", flex: 1 }}>
            <input
              ref={inputRef}
              className="rv-input"
              placeholder="Message…"
              value={draft}
              onChange={(e) => {
                const val = e.target.value;
                setDraft(val);
                const cursor = e.target.selectionStart ?? val.length;
                const slice = val.slice(0, cursor);
                const at = slice.lastIndexOf("@");
                if (at >= 0 && /^[A-Za-z0-9_]*$/.test(slice.slice(at + 1)) && (at === 0 || /\W/.test(slice[at - 1]!))) {
                  setMentionAnchor(at);
                  setMentionQuery(slice.slice(at + 1));
                } else {
                  setMentionQuery(null);
                }
              }}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
              style={{ width: "100%" }}
            />
            {mentionQuery !== null && (
              <MentionAutocomplete
                query={mentionQuery}
                candidates={mentionCandidates}
                onPick={onPickMention}
                onCancel={() => setMentionQuery(null)}
              />
            )}
          </div>
          <button
            type="button"
            className="rv-btn rv-btn-icon"
            data-variant="primary"
            onClick={() => void send()}
            disabled={!draft.trim()}
            aria-label="Send"
          >
            <I.Send size={16} />
          </button>
        </div>
      </footer>
    </aside>
  );
}

function ChatBubble({ msg }: { msg: ChatMessageDTO }): ReactElement {
  const time = new Date(msg.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const deleted = msg.deletedAt !== null || msg.body === null;
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          gap: "var(--s-2)",
          fontSize: "var(--t-xs)",
        }}
      >
        <span style={{ fontWeight: 600, color: "var(--text)" }}>{msg.authorName}</span>
        <span className="rv-mono" style={{ color: "var(--text-faint)", fontSize: "var(--t-2xs)" }}>
          {time}
        </span>
        {msg.editedAt && !deleted && (
          <span style={{ color: "var(--text-faint)", fontSize: "var(--t-2xs)" }}>(edited)</span>
        )}
      </div>
      <div
        style={{
          fontSize: "var(--t-sm)",
          color: deleted ? "var(--text-faint)" : "var(--text-mid)",
          wordBreak: "break-word",
          lineHeight: 1.4,
          fontStyle: deleted ? "italic" : "normal",
        }}
      >
        {deleted ? "(deleted)" : msg.body}
      </div>
    </div>
  );
}

const EMOJI_SET = [
  "👍", "❤️", "😂", "🔥", "😎", "🎉", "🤔", "👀",
  "🙌", "💯", "✅", "❌", "🚀", "🎯", "👋", "😅",
  "😭", "🥺", "😈", "💀", "🤝", "💪", "🙏", "✨",
];

function EmojiPicker({ onPick }: { onPick: (e: string) => void }): ReactElement {
  return (
    <div
      style={{
        position: "absolute",
        bottom: "calc(100% - var(--s-2))",
        left: "var(--s-3)",
        right: "var(--s-3)",
        background: "var(--bg-elev-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-md)",
        padding: "var(--s-2)",
        display: "grid",
        gridTemplateColumns: "repeat(8, 1fr)",
        gap: 2,
        boxShadow: "var(--shadow-2)",
      }}
    >
      {EMOJI_SET.map((e) => (
        <button
          key={e}
          type="button"
          onClick={() => onPick(e)}
          style={{
            appearance: "none",
            background: "transparent",
            border: 0,
            padding: 4,
            fontSize: 18,
            cursor: "pointer",
            borderRadius: "var(--r-sm)",
          }}
          onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-elev-3)")}
          onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
        >
          {e}
        </button>
      ))}
    </div>
  );
}

