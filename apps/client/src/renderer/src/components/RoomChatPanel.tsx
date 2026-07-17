import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ChatMessageDTO } from "@r3dvoice/shared";
import { ApiClient } from "../lib/api.js";
import { ensureTransport, setCurrentlyViewingThread, type ChatTransport } from "../lib/chat-transport.js";
import { useAuthStore } from "../lib/auth-context.js";
import { decryptDM, encryptDM, type EncryptedDMPayload } from "../lib/crypto.js";
import { loadKeyPair } from "../lib/key-storage.js";
import { ContextMenu, MenuItem, MenuDivider } from "./ContextMenu.js";
import { I } from "./Icons.js";
import { MentionAutocomplete } from "./MentionAutocomplete.js";

interface Props {
  threadType: "room" | "dm";
  threadId: string;
  localIdentity: string;
  localName: string;
  onClose(): void;
  mentionCandidates?: { id: string; handle: string; displayName: string }[];
  /**
   * "overlay": self-positioned right-side panel (in-room chat, 2.5f).
   * "fill": fills the parent container — the DMs thread pane (2.4), which
   * brings its own ThreadHeader, so no panel header is rendered.
   */
  variant?: "overlay" | "fill";
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
  variant = "overlay",
}: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);

  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  // 2.5k message context menu + edit-in-composer state.
  const [msgMenu, setMsgMenu] = useState<{ id: string; x: number; y: number; body: string; mine: boolean } | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 2.5l typing indicator: peers' typing pings extend the deadline; a ticker
  // clears it. Own sends are throttled via lastTypingSentRef.
  const [typingUntil, setTypingUntil] = useState<number>(0);
  const [now, setNow] = useState<number>(() => Date.now());
  const lastTypingSentRef = useRef<number>(0);
  useEffect(() => {
    if (typingUntil <= Date.now()) return;
    const t = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(t);
  }, [typingUntil]);
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
      } else if (event.type === "chat.typing") {
        if (event.threadType === threadType && event.threadId === threadId) {
          setTypingUntil(Date.now() + 4000);
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

    // Edit-in-composer (2.5k): same encrypt path, PATCH instead of POST,
    // optimistic local update — the server doesn't push edit events yet.
    if (editingId !== null) {
      const id = editingId;
      setEditingId(null);
      setDraft("");
      setError(null);
      try {
        await apiRef.current.editChatMessage(id, body);
        setMessages((prev) =>
          prev.map((m) => (m.id === id ? { ...m, body, editedAt: new Date().toISOString() } : m)),
        );
      } catch (e) {
        setError(e instanceof Error ? e.message : "failed to edit");
      }
      return;
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
      if (plain === null) return { ...m, body: "🔒 Sent before this device had your key" };
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

  void localName;

  return (
    <aside
      style={
        variant === "overlay"
          ? {
              position: "absolute",
              top: 0,
              right: 0,
              bottom: 0,
              width: 340,
              zIndex: 40,
              background: "var(--bg)",
              borderLeft: "1px solid var(--border-soft)",
              display: "grid",
              gridTemplateRows: "auto 1fr auto",
              animation: "rv-fade var(--d-mid) var(--ease-out) both",
            }
          : {
              height: "100%",
              width: "100%",
              background: "var(--bg)",
              display: "grid",
              gridTemplateRows: "1fr auto",
              minHeight: 0,
            }
      }
    >
      {variant === "overlay" && (
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
              persistent
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
      )}

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
          decrypted.map((m, i) => (
            <ChatBubble
              key={m.id}
              msg={m}
              me={m.authorId === localIdentity}
              followup={i > 0 && decrypted[i - 1]!.authorId === m.authorId}
              onContextMenu={(x, y) =>
                setMsgMenu({
                  id: m.id,
                  x,
                  y,
                  body: m.body ?? "",
                  mine: m.authorId === localIdentity && m.deletedAt === null,
                })
              }
            />
          ))
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
        {typingUntil > now && (
          <div
            style={{
              fontSize: "var(--t-2xs)",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              letterSpacing: ".08em",
              display: "flex",
              alignItems: "center",
              gap: 6,
            }}
          >
            <span className="rv-skeleton" style={{ width: 18, height: 6, borderRadius: 3 }} />
            typing…
          </div>
        )}
        {editingId !== null && (
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              fontSize: "var(--t-2xs)",
              color: "var(--text-dim)",
              fontFamily: "var(--font-mono)",
              textTransform: "uppercase",
              letterSpacing: ".1em",
            }}
          >
            <span style={{ color: "var(--rv-amber)" }}>✎</span> editing message
            <button
              type="button"
              onClick={() => {
                setEditingId(null);
                setDraft("");
              }}
              style={{
                appearance: "none",
                background: "transparent",
                border: 0,
                padding: 0,
                font: "inherit",
                color: "var(--text-dim)",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              cancel (esc)
            </button>
          </div>
        )}
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
                if (val.trim() && Date.now() - lastTypingSentRef.current > 2500) {
                  lastTypingSentRef.current = Date.now();
                  transportRef.current?.sendTyping(threadType, threadId);
                }
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
                if (e.key === "Escape" && editingId !== null) {
                  setEditingId(null);
                  setDraft("");
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

      {/* 2.5k message context menu */}
      {msgMenu && (
        <ContextMenu x={msgMenu.x} y={msgMenu.y} onClose={() => setMsgMenu(null)}>
          <MenuItem
            icon="⧉"
            label="Copy text"
            onClick={() => {
              void navigator.clipboard.writeText(msgMenu.body).catch(() => {});
              setMsgMenu(null);
            }}
          />
          {msgMenu.mine && (
            <>
              <MenuDivider />
              <MenuItem
                icon="✎"
                label="Edit message"
                onClick={() => {
                  setEditingId(msgMenu.id);
                  setDraft(msgMenu.body);
                  setMsgMenu(null);
                  inputRef.current?.focus();
                }}
              />
              <MenuItem
                icon="🗑"
                label="Delete message"
                tone="danger"
                onClick={() => {
                  const id = msgMenu.id;
                  setMsgMenu(null);
                  void apiRef.current
                    ?.deleteChatMessage(id)
                    .then(() =>
                      setMessages((prev) =>
                        prev.map((m) =>
                          m.id === id ? { ...m, body: null, deletedAt: new Date().toISOString() } : m,
                        ),
                      ),
                    )
                    .catch((e: unknown) =>
                      setError(e instanceof Error ? e.message : "failed to delete"),
                    );
                }}
              />
            </>
          )}
        </ContextMenu>
      )}
    </aside>
  );
}

// Deck 2.4 message row: avatar-side stack, mine reversed with the ink
// bubble, theirs white with a hairline; follow-ups from the same author
// drop the name/time and tighten up.
function ChatBubble({
  msg,
  me,
  followup,
  onContextMenu,
}: {
  msg: ChatMessageDTO;
  me: boolean;
  followup: boolean;
  onContextMenu?: (x: number, y: number) => void;
}): ReactElement {
  const time = new Date(msg.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const deleted = msg.deletedAt !== null || msg.body === null;
  return (
    <div
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(e.clientX, e.clientY);
      }}
      style={{
        display: "flex",
        flexDirection: me ? "row-reverse" : "row",
        gap: "var(--s-2)",
        marginTop: followup ? -6 : 0,
      }}
    >
      <div
        style={{
          display: "flex",
          flexDirection: "column",
          gap: 3,
          maxWidth: "78%",
          alignItems: me ? "flex-end" : "flex-start",
        }}
      >
        {!followup && (
          <div
            style={{
              display: "flex",
              flexDirection: me ? "row-reverse" : "row",
              alignItems: "baseline",
              gap: "var(--s-2)",
              fontSize: "var(--t-2xs)",
            }}
          >
            <span style={{ fontWeight: 600, color: "var(--text-mid)" }}>
              {me ? "You" : msg.authorName}
            </span>
            <span className="rv-mono" style={{ color: "var(--text-faint)" }}>{time}</span>
            {msg.editedAt && !deleted && (
              <span style={{ color: "var(--text-faint)" }}>(edited)</span>
            )}
          </div>
        )}
        <div
          style={{
            padding: "8px 13px",
            borderRadius: 14,
            fontSize: "var(--t-sm)",
            lineHeight: 1.5,
            wordBreak: "break-word",
            background: deleted ? "transparent" : me ? "var(--bubble-me)" : "var(--bubble-them)",
            color: deleted ? "var(--text-faint)" : me ? "#fff" : "var(--text)",
            border: deleted
              ? "1px dashed var(--border-soft)"
              : me
                ? "1px solid var(--bubble-me)"
                : "1px solid var(--border-soft)",
            fontStyle: deleted ? "italic" : "normal",
          }}
        >
          {deleted ? "(deleted)" : msg.body}
        </div>
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

