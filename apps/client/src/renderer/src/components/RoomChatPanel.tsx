import { memo, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import type { ChatMessageDTO, MessageAttachment, PollDTO } from "@r3dvoice/shared";
import { ApiClient } from "../lib/api.js";
import { ensureTransport, setCurrentlyViewingThread, type ChatTransport } from "../lib/chat-transport.js";
import { useAuthStore } from "../lib/auth-context.js";
import { decryptDM, encryptDM, type EncryptedDMPayload } from "../lib/crypto.js";
import { loadKeyPair, parseKeyBackup, saveKeyPair } from "../lib/key-storage.js";
import { Avatar } from "./Avatar.js";
import { useDismiss } from "../lib/use-dismiss.js";
import { pushToast } from "../lib/toast-store.js";

// Shared style for the composer "+" menu rows.
const PLUS_ITEM_STYLE: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--s-2)",
  width: "100%",
  textAlign: "left",
  padding: "var(--s-2) var(--s-3)",
  borderRadius: "var(--r-sm)",
  background: "transparent",
  border: 0,
  color: "var(--text)",
  font: "inherit",
  fontSize: "var(--t-sm)",
  cursor: "pointer",
};

// #30 attachment upload cap — matched to the server's accepted size.
const MAX_ATTACHMENT_BYTES = 8 * 1024 * 1024;

/** Read a File into a `data:` URL for the upload endpoint. */
function readFileAsDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ""));
    reader.onerror = () => reject(new Error("Couldn't read that file."));
    reader.readAsDataURL(file);
  });
}

/** Compact human-readable file size (e.g. "3.4 MB"). */
function humanSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Pick a glyph for a non-image attachment from its MIME type. */
function fileGlyph(mime: string): string {
  if (mime.startsWith("video/")) return "🎞️";
  if (mime.startsWith("audio/")) return "🎧";
  if (mime === "application/pdf") return "📄";
  if (mime.startsWith("text/")) return "📃";
  if (mime.includes("zip")) return "🗜️";
  return "📎";
}

/** A message the local user is sending — shown optimistically before the
 *  server echoes it back. `text` is the plaintext (used for display + retry;
 *  for DMs the wire body is re-encrypted per attempt). */
type PendingMessage = {
  clientId: string;
  text: string;
  createdAt: string;
  status: "sending" | "failed";
};

/** Inline emphasis: **bold**, *italic* / _italic_. Input is plain text —
 *  everything is emitted as React text/element nodes, which React escapes,
 *  so there's no HTML-injection surface. */
function emphasize(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  const re = /(\*\*[^*\n]+\*\*|\*[^*\n]+\*|_[^_\n]+_)/g;
  let last = 0;
  let m: RegExpExecArray | null;
  let i = 0;
  while ((m = re.exec(text)) !== null) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const tok = m[0];
    if (tok.startsWith("**")) {
      out.push(
        <strong key={`${keyBase}-b${i}`} style={{ fontWeight: 700 }}>
          {tok.slice(2, -2)}
        </strong>,
      );
    } else {
      out.push(<em key={`${keyBase}-i${i}`}>{tok.slice(1, -1)}</em>);
    }
    last = m.index + tok.length;
    i++;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/**
 * Render a message body with markdown basics (bold/italic/inline code),
 * URL linkification, and @mention pills. XSS-safe: user content only ever
 * lands in React text nodes (auto-escaped) and links are restricted to
 * http(s) schemes, so no `javascript:` href can slip through.
 */
function renderRichBody(body: string, hasMentions: boolean, onDark: boolean): ReactNode {
  if (!body) return body;
  const master = hasMentions
    ? /(`[^`\n]+`|https?:\/\/[^\s<>()]+|@[A-Za-z0-9_]{3,24})/g
    : /(`[^`\n]+`|https?:\/\/[^\s<>()]+)/g;
  const parts = body.split(master);
  const nodes: ReactNode[] = [];
  parts.forEach((part, i) => {
    if (!part) return;
    if (/^`[^`\n]+`$/.test(part)) {
      nodes.push(
        <code
          key={`c${i}`}
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "0.92em",
            background: "color-mix(in srgb, currentColor 12%, transparent)",
            padding: "1px 5px",
            borderRadius: 4,
          }}
        >
          {part.slice(1, -1)}
        </code>,
      );
    } else if (/^https?:\/\//.test(part)) {
      // Trailing punctuation usually belongs to the sentence, not the URL.
      const trail = part.match(/[.,!?;:'")\]]+$/);
      const tail = trail ? trail[0] : "";
      const url = tail ? part.slice(0, -tail.length) : part;
      nodes.push(
        <a
          key={`u${i}`}
          href={url}
          target="_blank"
          rel="noreferrer noopener"
          style={{
            color: onDark ? "#fff" : "var(--accent)",
            textDecoration: "underline",
            wordBreak: "break-all",
          }}
        >
          {url}
        </a>,
      );
      if (tail) nodes.push(tail);
    } else if (hasMentions && /^@[A-Za-z0-9_]{3,24}$/.test(part)) {
      nodes.push(
        <span
          key={`m${i}`}
          style={{
            background: "color-mix(in srgb, currentColor 14%, transparent)",
            borderRadius: 4,
            padding: "0 3px",
            fontWeight: 600,
          }}
        >
          {part}
        </span>,
      );
    } else {
      nodes.push(...emphasize(part, `t${i}`));
    }
  });
  return <>{nodes}</>;
}
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
   * "overlay": self-positioned right-side panel.
   * "fill": fills the parent container — the DMs thread pane (2.4), which
   * brings its own ThreadHeader, so no panel header is rendered.
   * "dock": in-room chat (2.5f) — a full-width bottom band that fills its grid
   * row (below the control bar), headerless like "fill" but with a top border.
   */
  variant?: "overlay" | "fill" | "dock";
  /** Channel name for the composer placeholder ("Message #<name>…"). */
  channelName?: string | undefined;
  /** DM peer's display name — labels the overlay header so an Open-DM panel
   *  reads as a conversation with that person rather than the generic chrome. */
  peerName?: string | undefined;
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
  channelName,
  peerName,
}: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);

  const [messages, setMessages] = useState<ChatMessageDTO[]>([]);
  // Distinguish "still loading history" from "loaded, but empty" so we don't
  // flash "No messages yet." over a thread that's mid-fetch.
  const [historyLoading, setHistoryLoading] = useState(true);
  // Optimistic outbound messages — rendered greyed as "sending…" until the
  // server accepts them, then flipped to "failed · retry" on error.
  const [pending, setPending] = useState<PendingMessage[]>([]);
  // Unread affordances: the id of the first message that arrived while the
  // user was scrolled up (the "new messages" divider) + a running count that
  // drives the "N new ↓" jump pill.
  const [unreadDividerId, setUnreadDividerId] = useState<string | null>(null);
  const [newBelow, setNewBelow] = useState(0);
  const hydratedRef = useRef(false);
  const prevLastIdRef = useRef<string | null>(null);
  const [draft, setDraft] = useState("");
  const [emojiOpen, setEmojiOpen] = useState(false);
  const emojiWrapRef = useRef<HTMLDivElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  useDismiss(emojiOpen, () => setEmojiOpen(false), [emojiWrapRef, emojiBtnRef]);
  // Composer "+" actions menu (Upload a File / Create Poll). Platform-split so
  // mobile can later swap in touch-native items; desktop shows both.
  const [plusOpen, setPlusOpen] = useState(false);
  const plusBtnRef = useRef<HTMLButtonElement>(null);
  const plusMenuRef = useRef<HTMLDivElement>(null);
  useDismiss(plusOpen, () => setPlusOpen(false), [plusMenuRef, plusBtnRef]);
  // #29/#30 — attachments + polls. Room-only: DMs are E2EE and the server
  // rejects them, so the composer's "+" items are disabled in DM threads.
  const attachmentsAllowed = threadType === "room";
  const attachInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [pollOpen, setPollOpen] = useState(false);
  const [pollQuestion, setPollQuestion] = useState("");
  const [pollOptions, setPollOptions] = useState<string[]>(["", ""]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  // 2.5k message context menu + edit-in-composer state.
  const [msgMenu, setMsgMenu] = useState<{ id: string; x: number; y: number; body: string; mine: boolean; pinned: boolean } | null>(null);
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState<ChatMessageDTO[] | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  // 2.5l typing indicator: peers' typing pings extend the deadline; a ticker
  // clears it. Own sends are throttled via lastTypingSentRef.
  const [typingUntil, setTypingUntil] = useState<number>(0);
  const [typingUserId, setTypingUserId] = useState<string | null>(null);
  const [now, setNow] = useState<number>(() => Date.now());
  const lastTypingSentRef = useRef<number>(0);
  useEffect(() => {
    if (typingUntil <= Date.now()) return;
    const t = setInterval(() => {
      const n = Date.now();
      setNow(n);
      // Once the deadline passes there's nothing left to count down — stop the
      // ticker so an expired indicator doesn't re-render the panel forever.
      if (n >= typingUntil) clearInterval(t);
    }, 1000);
    return () => clearInterval(t);
  }, [typingUntil]);
  const listRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  // Scroll-up pagination: history loads 50 at a time; reaching the top
  // fetches the previous page and preserves the scroll position.
  const [hasMore, setHasMore] = useState(true);
  const loadingOlderRef = useRef(false);
  const apiRef = useRef<ApiClient | null>(null);
  const transportRef = useRef<ChatTransport | null>(null);

  // E2EE state — only relevant for DMs.
  // keyEpoch bumps when the restore banner installs a key in-place, so the
  // memo re-reads localStorage and the whole history decrypts without a reload.
  const [keyEpoch, setKeyEpoch] = useState(0);
  const [restoreMsg, setRestoreMsg] = useState<{ ok: boolean; text: string } | null>(null);
  const keyFileInputRef = useRef<HTMLInputElement | null>(null);
  const myKeyPair = useMemo(
    () => (threadType === "dm" ? loadKeyPair() : null),
    [threadType, keyEpoch],
  );
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

    // Reset per-thread transient state so nothing bleeds across a switch.
    setHistoryLoading(true);
    setPending([]);
    setNewBelow(0);
    setUnreadDividerId(null);
    hydratedRef.current = false;
    prevLastIdRef.current = null;

    let cancelled = false;
    void api
      .chatHistory(threadType, threadId, { limit: 50 })
      .then((res) => {
        if (!cancelled) {
          setMessages(res.messages);
          setHasMore(res.messages.length >= 50);
          setHistoryLoading(false);
        }
      })
      .catch((e: Error) => {
        if (!cancelled) {
          setError(e.message);
          setHistoryLoading(false);
        }
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
          // Dedup: our own optimistic send also inserts the accepted message
          // when chatSend() resolves, so the WS echo can be a duplicate.
          setMessages((prev) =>
            prev.some((m) => m.id === event.message.id) ? prev : [...prev, event.message],
          );
        }
      } else if (event.type === "edited") {
        if (event.message.threadType === threadType && event.message.threadId === threadId) {
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.message.id ? { ...event.message, ...(event.message.reactions ?? m.reactions ? { reactions: event.message.reactions ?? m.reactions ?? [] } : {}) } : m,
            ),
          );
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
          setTypingUserId(event.userId);
        }
      } else if (event.type === "pinned") {
        if (event.message.threadType === threadType && event.message.threadId === threadId) {
          // Broadcast DTOs carry no reaction aggregate — keep what we have.
          setMessages((prev) =>
            prev.map((m) =>
              m.id === event.message.id ? { ...event.message, ...(event.message.reactions ?? m.reactions ? { reactions: event.message.reactions ?? m.reactions ?? [] } : {}) } : m,
            ),
          );
          setPins(null); // refetch on next open
        }
      } else if (event.type === "unpinned") {
        if (event.threadType === threadType && event.threadId === threadId) {
          setMessages((prev) => prev.map((m) => (m.id === event.id ? { ...m, pinnedAt: null } : m)));
          setPins((prev) => prev?.filter((x) => x.id !== event.id) ?? null);
        }
      } else if (event.type === "reaction") {
        if (event.threadType === threadType && event.threadId === threadId) {
          const mineEvent = event.userId === localIdentity;
          setMessages((prev) =>
            prev.map((m) => {
              if (m.id !== event.messageId) return m;
              const list = [...(m.reactions ?? [])];
              const idx = list.findIndex((r) => r.emoji === event.emoji);
              if (event.op === "add") {
                if (idx >= 0) {
                  const cur = list[idx]!;
                  // Own optimistic add may already be counted — don't double.
                  if (mineEvent && cur.mine) return m;
                  list[idx] = { ...cur, count: cur.count + 1, mine: cur.mine || mineEvent };
                } else {
                  list.push({ emoji: event.emoji, count: 1, mine: mineEvent });
                }
              } else if (idx >= 0) {
                const cur = list[idx]!;
                if (mineEvent && !cur.mine) return m;
                const next = { ...cur, count: cur.count - 1, mine: cur.mine && !mineEvent };
                if (next.count <= 0) list.splice(idx, 1);
                else list[idx] = next;
              }
              return { ...m, reactions: list };
            }),
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

  // Jump-to-bottom + reset unread affordances.
  const jumpToBottom = (): void => {
    const el = listRef.current;
    if (el) el.scrollTop = el.scrollHeight;
    setNewBelow(0);
    setUnreadDividerId(null);
  };

  const send = async (): Promise<void> => {
    const text = applySlashCommand(draft.trim());
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

    // Optimistic echo: show a greyed "sending…" bubble immediately so a slow
    // link doesn't read as a dropped message. It reconciles to the real
    // message on accept, or flips to a retryable "failed" state on error.
    const clientId = `pending-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    setPending((p) => [...p, { clientId, text, createdAt: new Date().toISOString(), status: "sending" }]);
    requestAnimationFrame(() => {
      const el = listRef.current;
      if (el) el.scrollTop = el.scrollHeight;
    });
    try {
      const res = await apiRef.current.chatSend({ threadType, threadId, body });
      setPending((p) => p.filter((x) => x.clientId !== clientId));
      // Insert the accepted message directly; the WS echo is deduped by id.
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
      setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: "failed" } : x)));
    }
  };

  // Retry a failed optimistic message (re-encrypts per attempt for DMs).
  const retryPending = async (clientId: string): Promise<void> => {
    const item = pending.find((x) => x.clientId === clientId);
    if (!item || !apiRef.current) return;
    let body = item.text;
    if (threadType === "dm") {
      if (!myKeyPair || !peerPublicKey) {
        setError("Can't retry — an encryption key is unavailable on this device.");
        return;
      }
      body = JSON.stringify(encryptDM(item.text, peerPublicKey, myKeyPair));
    }
    setError(null);
    setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: "sending" } : x)));
    try {
      const res = await apiRef.current.chatSend({ threadType, threadId, body });
      setPending((p) => p.filter((x) => x.clientId !== clientId));
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "send failed");
      setPending((p) => p.map((x) => (x.clientId === clientId ? { ...x, status: "failed" } : x)));
    }
  };

  const discardPending = (clientId: string): void => {
    setPending((p) => p.filter((x) => x.clientId !== clientId));
  };

  // #30 attachments — read the picked file as a data URL, upload it, then send
  // a room message carrying the returned descriptor. Room-only, so no E2EE
  // encrypt step: the body is the plain draft (may be empty).
  const onPickAttachment = async (file: File): Promise<void> => {
    const api = apiRef.current;
    if (!api) return;
    if (file.size > MAX_ATTACHMENT_BYTES) {
      pushToast({ kind: "error", text: `“${file.name}” is too large — 8 MB max.` });
      return;
    }
    setUploading(true);
    setError(null);
    try {
      const dataUrl = await readFileAsDataUrl(file);
      const attachment = await api.uploadAttachment(dataUrl, file.name);
      const body = draft.trim();
      setDraft("");
      const res = await api.chatSend({ threadType, threadId, body, attachments: [attachment] });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
    } catch (e) {
      pushToast({ kind: "error", text: e instanceof Error ? e.message : "Upload failed." });
    } finally {
      setUploading(false);
    }
  };

  // #29 poll composer helpers.
  const resetPoll = (): void => {
    setPollOpen(false);
    setPollQuestion("");
    setPollOptions(["", ""]);
  };
  const nonEmptyPollOptions = pollOptions.map((o) => o.trim()).filter((o) => o.length > 0);
  const canCreatePoll = pollQuestion.trim().length > 0 && nonEmptyPollOptions.length >= 2;
  const submitPoll = async (): Promise<void> => {
    const api = apiRef.current;
    if (!api || !canCreatePoll) return;
    const question = pollQuestion.trim();
    const options = nonEmptyPollOptions;
    resetPoll();
    setError(null);
    try {
      const res = await api.chatSend({ threadType, threadId, body: "", poll: { question, options } });
      setMessages((prev) => (prev.some((m) => m.id === res.message.id) ? prev : [...prev, res.message]));
    } catch (e) {
      setError(e instanceof Error ? e.message : "Couldn't create the poll.");
    }
  };

  // Restore an E2EE key backup (Settings → "Download key backup" on the device
  // that has the key) directly from the DM view, so a keyless device can unlock
  // its history in place instead of having to log out and use the login screen.
  const restoreKeyFile = (file: File): void => {
    const reader = new FileReader();
    reader.onload = () => {
      const kp = parseKeyBackup(String(reader.result ?? ""));
      if (!kp) {
        setRestoreMsg({ ok: false, text: "That file isn't a valid R3DVoice key backup." });
        return;
      }
      saveKeyPair(kp);
      setKeyEpoch((n) => n + 1);
      setRestoreMsg({ ok: true, text: "Key restored — your messages should decrypt now." });
    };
    reader.onerror = () => setRestoreMsg({ ok: false, text: "Couldn't read that file." });
    reader.readAsText(file);
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
      const plain = decryptDM(payload, myKeyPair, peerPublicKey ?? undefined);
      if (plain === null) return { ...m, body: "🔒 Sent before this device had your key" };
      return { ...m, body: plain };
    });
  }, [messages, threadType, myKeyPair, peerPublicKey]);

  // Deleted messages vanish from the stream (Discord semantics) instead of
  // leaving tombstone rows that read as blank gaps.
  const visible = useMemo(() => decrypted.filter((m) => m.deletedAt === null), [decrypted]);

  // Autoscroll + unread bookkeeping. On the first paint we jump to the bottom.
  // After that: my own sends and arrivals-while-near-bottom keep the view
  // pinned; arrivals while scrolled up raise the "N new ↓" pill and drop an
  // unread divider before the first unseen message.
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const last = visible[visible.length - 1];
    const lastId = last?.id ?? null;
    const appended = lastId !== null && lastId !== prevLastIdRef.current;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    const mine = last?.authorId === localIdentity;
    if (!hydratedRef.current) {
      el.scrollTop = el.scrollHeight;
      if (lastId !== null) hydratedRef.current = true;
    } else if (appended) {
      if (nearBottom || mine) {
        el.scrollTop = el.scrollHeight;
        setNewBelow(0);
        setUnreadDividerId(null);
      } else {
        setNewBelow((n) => n + 1);
        setUnreadDividerId((cur) => cur ?? lastId);
      }
    } else if (nearBottom) {
      // Non-append change (e.g. a reaction) while pinned — stay pinned.
      el.scrollTop = el.scrollHeight;
    }
    prevLastIdRef.current = lastId;
  }, [visible, localIdentity]);

  const insertEmoji = (e: string): void => {
    setDraft((d) => d + e);
    inputRef.current?.focus();
  };

  // 2.5k reactions — optimistic toggle; the WS echo is deduped by the
  // mine-guards in the event handler.
  const toggleReaction = useCallback((messageId: string, emoji: string, mine: boolean): void => {
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== messageId) return m;
        const list = [...(m.reactions ?? [])];
        const idx = list.findIndex((r) => r.emoji === emoji);
        if (!mine) {
          if (idx >= 0) list[idx] = { ...list[idx]!, count: list[idx]!.count + 1, mine: true };
          else list.push({ emoji, count: 1, mine: true });
        } else if (idx >= 0) {
          const next = { ...list[idx]!, count: list[idx]!.count - 1, mine: false };
          if (next.count <= 0) list.splice(idx, 1);
          else list[idx] = next;
        }
        return { ...m, reactions: list };
      }),
    );
    const call = mine
      ? apiRef.current?.removeReaction(messageId, emoji)
      : apiRef.current?.addReaction(messageId, emoji);
    void call?.catch(() => {
      /* WS truth wins on next event; worst case a refresh corrects */
    });
  }, []);

  // #29 poll vote — optimistically toggle the caller's choice, then reconcile
  // with the server DTO. Re-clicking the current option retracts the vote.
  const handleVote = useCallback((msg: ChatMessageDTO, optionId: string): void => {
    const api = apiRef.current;
    if (!api || !msg.poll) return;
    setMessages((prev) =>
      prev.map((m) => {
        if (m.id !== msg.id || !m.poll) return m;
        const poll = m.poll;
        const tally = { ...poll.tally };
        const prevVote = poll.myVote;
        let totalVotes = poll.totalVotes;
        if (prevVote === optionId) {
          tally[optionId] = Math.max(0, (tally[optionId] ?? 0) - 1);
          totalVotes = Math.max(0, totalVotes - 1);
          return { ...m, poll: { ...poll, tally, myVote: null, totalVotes } };
        }
        if (prevVote) tally[prevVote] = Math.max(0, (tally[prevVote] ?? 0) - 1);
        else totalVotes += 1;
        tally[optionId] = (tally[optionId] ?? 0) + 1;
        return { ...m, poll: { ...poll, tally, myVote: optionId, totalVotes } };
      }),
    );
    void api
      .votePoll(msg.id, optionId)
      .then((updated) => {
        setMessages((prev) => prev.map((m) => (m.id === updated.id ? { ...updated } : m)));
      })
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "Vote failed."));
  }, []);

  // Stable per-render handlers so the memoized ChatBubble holds across composer
  // keystrokes — each takes its own message rather than closing over `m`.
  const handleBubbleToggleReaction = useCallback(
    (m: ChatMessageDTO, emoji: string, mine: boolean) => toggleReaction(m.id, emoji, mine),
    [toggleReaction],
  );
  const handleBubbleContextMenu = useCallback(
    (m: ChatMessageDTO, x: number, y: number) => {
      setDeleteArmed(false);
      setMsgMenu({
        id: m.id,
        x,
        y,
        body: m.body ?? "",
        mine: m.authorId === localIdentity && m.deletedAt === null,
        pinned: (m.pinnedAt ?? null) !== null,
      });
    },
    [localIdentity],
  );

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
              position: "relative",
              // dock (in-room, 2.5f): a border separates the chat band from the
              // control bar sitting directly above it.
              ...(variant === "dock" && { borderTop: "1px solid var(--border-soft)" }),
            }
      }
    >
      {/* 2.5p pinned messages: floating toggle + overlay panel */}
      <button
        type="button"
        title="Pinned messages"
        onClick={() => {
          setPinsOpen((v) => !v);
          if (pins === null) {
            void apiRef.current
              ?.listPins(threadType, threadId)
              .then((r) => setPins(r.messages))
              .catch(() => setPins([]));
          }
        }}
        style={{
          position: "absolute",
          top: variant === "overlay" ? "3.2rem" : "var(--s-2)",
          right: "var(--s-2)",
          zIndex: 45,
          width: "1.75rem",
          height: "1.75rem",
          borderRadius: "var(--r-sm)",
          border: "1px solid var(--border)",
          background: pinsOpen ? "var(--accent-tint)" : "var(--bg-elev)",
          cursor: "pointer",
          fontSize: 13,
          display: "grid",
          placeItems: "center",
        }}
      >
        📌
      </button>
      {pinsOpen && (
        <div
          className="rv-menu rv-fade-in rv-scroll"
          style={{
            position: "absolute",
            top: variant === "overlay" ? "5.2rem" : "2.4rem",
            right: "var(--s-2)",
            width: 280,
            maxHeight: 300,
            overflowY: "auto",
            zIndex: 46,
            padding: "var(--s-3)",
          }}
        >
          <div className="rv-label" style={{ fontSize: "var(--t-2xs)", marginBottom: "var(--s-2)" }}>
            Pinned messages
          </div>
          {pins === null ? (
            <div className="rv-skeleton" style={{ height: "2rem" }} />
          ) : pins.length === 0 ? (
            <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)", padding: "var(--s-2) 0" }}>
              Nothing pinned yet — right-click a message.
            </div>
          ) : (
            pins.map((p) => (
              <div key={p.id} style={{ padding: "var(--s-2) 0", borderBottom: "1px solid var(--border-soft)" }}>
                <div style={{ display: "flex", alignItems: "baseline", gap: "var(--s-2)", fontSize: "var(--t-2xs)" }}>
                  <span style={{ fontWeight: 600, color: "var(--text-mid)", flex: 1 }}>{p.authorName}</span>
                  <button
                    type="button"
                    onClick={() => {
                      void apiRef.current?.unpinChatMessage(p.id).then(() => {
                        setPins((prev) => prev?.filter((x) => x.id !== p.id) ?? null);
                        setMessages((prev) => prev.map((m) => (m.id === p.id ? { ...m, pinnedAt: null } : m)));
                      });
                    }}
                    style={{
                      appearance: "none",
                      background: "transparent",
                      border: 0,
                      padding: 0,
                      fontSize: "var(--t-2xs)",
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      textDecoration: "underline",
                      textUnderlineOffset: 2,
                    }}
                  >
                    unpin
                  </button>
                </div>
                <div style={{ fontSize: "var(--t-xs)", color: "var(--text)", wordBreak: "break-word", marginTop: 2 }}>
                  {(() => {
                    const raw = p.body ?? "(deleted)";
                    if (threadType !== "dm" || !raw.startsWith("{") || !myKeyPair) return raw;
                    try {
                      const env = JSON.parse(raw) as EncryptedDMPayload;
                      if (env?.v !== 1) return raw;
                      return decryptDM(env, myKeyPair, peerPublicKey ?? undefined) ?? "🔒 Encrypted message";
                    } catch {
                      return raw;
                    }
                  })()}
                </div>
              </div>
            ))
          )}
        </div>
      )}
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
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", minWidth: 0 }}>
            <I.Chat size={14} />
            <span
              className="rv-label"
              style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}
            >
              {threadType === "dm" ? (peerName ?? "Direct message") : "Room chat"}
            </span>
            <span
              className="rv-mono"
              style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)", flexShrink: 0 }}
            >
              {threadType === "dm" ? "direct" : "persistent"}
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
        onScroll={(e) => {
          const el = e.currentTarget;
          if (el.scrollTop > 40 || !hasMore || loadingOlderRef.current) return;
          const oldest = messages[0];
          if (!oldest || !apiRef.current) return;
          loadingOlderRef.current = true;
          const prevHeight = el.scrollHeight;
          void apiRef.current
            .chatHistory(threadType, threadId, { before: oldest.createdAt, limit: 50 })
            .then((res) => {
              setHasMore(res.messages.length >= 50);
              if (res.messages.length > 0) {
                setMessages((prev) => [...res.messages, ...prev]);
                // Keep the viewport anchored on the previously-visible message.
                requestAnimationFrame(() => {
                  el.scrollTop += el.scrollHeight - prevHeight;
                });
              }
            })
            .finally(() => {
              loadingOlderRef.current = false;
            });
        }}
        style={{
          padding: "var(--s-4)",
          overflowY: "auto",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
        }}
      >
        {threadType === "dm" && !myKeyPair && (
          <div
            style={{
              position: "sticky",
              top: 0,
              zIndex: 6,
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-2)",
              padding: "var(--s-3)",
              borderRadius: "var(--r-md)",
              background: "var(--bg-elev)",
              border: "1px solid var(--border)",
              boxShadow: "var(--shadow-sm, 0 2px 8px rgba(0,0,0,.25))",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", fontWeight: 600, fontSize: "var(--t-sm)" }}>
              <span aria-hidden>🔒</span>
              <span>Encrypted messages need your key on this device</span>
            </div>
            <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", lineHeight: 1.5 }}>
              Your encryption key isn&rsquo;t on this device yet, so this conversation can&rsquo;t be read.
              Restore it from a key backup, or sign in fresh on the device that already has your key to
              sync it automatically.
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", flexWrap: "wrap" }}>
              <button
                type="button"
                className="rv-btn"
                data-variant="primary"
                onClick={() => keyFileInputRef.current?.click()}
              >
                Restore key backup&hellip;
              </button>
              <input
                ref={keyFileInputRef}
                type="file"
                accept="application/json,.json"
                style={{ display: "none" }}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  if (f) restoreKeyFile(f);
                  e.target.value = "";
                }}
              />
              {restoreMsg && (
                <span
                  style={{
                    fontSize: "var(--t-xs)",
                    color: restoreMsg.ok ? "var(--ok, #4caf50)" : "var(--danger, #e5484d)",
                  }}
                >
                  {restoreMsg.text}
                </span>
              )}
            </div>
          </div>
        )}
        {historyLoading ? (
          <ChatHistorySkeleton />
        ) : visible.length === 0 && pending.length === 0 ? (
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
          <>
            {visible.map((m, i) => {
              const prev = i > 0 ? visible[i - 1]! : null;
              const dayChanged =
                prev === null ||
                new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
              const showUnread = unreadDividerId !== null && m.id === unreadDividerId;
              return (
                <div key={m.id} style={{ display: "contents" }}>
                  {showUnread && <NewMessagesDivider count={newBelow} />}
                  {dayChanged && <DayDivider iso={m.createdAt} />}
                  <ChatBubble
                    msg={m}
                    me={m.authorId === localIdentity}
                    followup={!dayChanged && !showUnread && prev !== null && prev.authorId === m.authorId}
                    onToggleReaction={handleBubbleToggleReaction}
                    onContextMenu={handleBubbleContextMenu}
                    onVote={handleVote}
                  />
                </div>
              );
            })}
            {pending.map((p) => (
              <PendingBubble
                key={p.clientId}
                item={p}
                onRetry={() => void retryPending(p.clientId)}
                onDiscard={() => discardPending(p.clientId)}
              />
            ))}
          </>
        )}
        {newBelow > 0 && (
          <div style={{ position: "sticky", bottom: 4, display: "flex", justifyContent: "center", pointerEvents: "none", zIndex: 6 }}>
            <button
              type="button"
              onClick={jumpToBottom}
              style={{
                pointerEvents: "auto",
                appearance: "none",
                cursor: "pointer",
                display: "inline-flex",
                alignItems: "center",
                gap: 6,
                padding: "4px 12px",
                borderRadius: 999,
                border: "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))",
                background: "var(--accent)",
                color: "var(--on-accent)",
                fontSize: "var(--t-2xs)",
                fontWeight: 600,
                boxShadow: "var(--shadow-1)",
              }}
            >
              {newBelow} new message{newBelow === 1 ? "" : "s"} ↓
            </button>
          </div>
        )}
        {error && (
          <div
            role="alert"
            style={{
              color: "var(--danger)",
              fontSize: "var(--t-xs)",
              padding: "var(--s-2) var(--s-3)",
              border: "1px solid color-mix(in oklch, var(--danger) 40%, transparent)",
              borderRadius: "var(--r-sm)",
              background: "color-mix(in oklch, var(--danger) 8%, var(--bg-elev-2))",
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
            {(() => {
              const name = messages.find((m) => m.authorId === typingUserId)?.authorName;
              return name ? `${name} is typing…` : "typing…";
            })()}
          </div>
        )}
        {draft.startsWith("/") && !draft.includes(" ") && draft.length > 1 &&
          SLASH_COMMANDS.some((c) => c.cmd.startsWith(draft)) && (
          <div className="rv-menu" style={{ position: "absolute", bottom: "calc(100% - var(--s-2))", left: "var(--s-3)", right: "var(--s-3)", zIndex: 44 }}>
            {SLASH_COMMANDS.filter((c) => c.cmd.startsWith(draft)).map((c) => (
              <button
                key={c.cmd}
                type="button"
                className="rv-menu-item"
                onClick={() => {
                  setDraft(c.cmd + " ");
                  inputRef.current?.focus();
                }}
              >
                <span className="rv-mono" style={{ fontWeight: 600 }}>{c.cmd}</span>
                <span style={{ marginLeft: "auto", fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>{c.hint}</span>
              </button>
            ))}
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
        {emojiOpen && (
          <div ref={emojiWrapRef}>
            <EmojiPicker onPick={insertEmoji} />
          </div>
        )}
        {/* #29 poll composer — question + 2–6 options, room threads only. */}
        {pollOpen && attachmentsAllowed && (
          <div
            style={{
              display: "flex",
              flexDirection: "column",
              gap: "var(--s-2)",
              padding: "var(--s-3)",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--border)",
              background: "var(--bg-elev)",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              <span className="rv-label" style={{ display: "flex", alignItems: "center", gap: 6 }}>
                <span aria-hidden>📊</span> Create a poll
              </span>
              <button
                type="button"
                onClick={resetPoll}
                aria-label="Cancel poll"
                style={{
                  appearance: "none",
                  background: "transparent",
                  border: 0,
                  padding: 0,
                  color: "var(--text-dim)",
                  cursor: "pointer",
                  fontSize: "var(--t-sm)",
                  lineHeight: 1,
                }}
              >
                ✕
              </button>
            </div>
            <input
              className="rv-input"
              placeholder="Ask a question…"
              value={pollQuestion}
              maxLength={200}
              onChange={(e) => setPollQuestion(e.target.value)}
            />
            {pollOptions.map((opt, i) => (
              <div key={i} style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
                <input
                  className="rv-input"
                  placeholder={`Option ${i + 1}`}
                  value={opt}
                  maxLength={100}
                  onChange={(e) =>
                    setPollOptions((o) => o.map((x, idx) => (idx === i ? e.target.value : x)))
                  }
                  style={{ flex: 1 }}
                />
                {pollOptions.length > 2 && (
                  <button
                    type="button"
                    aria-label={`Remove option ${i + 1}`}
                    onClick={() => setPollOptions((o) => o.filter((_, idx) => idx !== i))}
                    style={{
                      appearance: "none",
                      background: "transparent",
                      border: 0,
                      padding: "0 var(--s-1)",
                      color: "var(--text-dim)",
                      cursor: "pointer",
                      fontSize: "var(--t-sm)",
                      lineHeight: 1,
                    }}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
              {pollOptions.length < 6 ? (
                <button
                  type="button"
                  onClick={() => setPollOptions((o) => (o.length >= 6 ? o : [...o, ""]))}
                  style={{
                    appearance: "none",
                    background: "transparent",
                    border: 0,
                    padding: 0,
                    font: "inherit",
                    fontSize: "var(--t-xs)",
                    color: "var(--accent)",
                    cursor: "pointer",
                  }}
                >
                  + Add option
                </button>
              ) : (
                <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>Max 6 options</span>
              )}
              <button
                type="button"
                className="rv-btn"
                data-variant="primary"
                disabled={!canCreatePoll}
                onClick={() => void submitPoll()}
              >
                Create poll
              </button>
            </div>
          </div>
        )}
        {uploading && (
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
            uploading…
          </div>
        )}
        <input
          ref={attachInputRef}
          type="file"
          accept="image/*,video/mp4,audio/*,.pdf,.txt,.zip"
          style={{ display: "none" }}
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) void onPickAttachment(f);
            e.target.value = "";
          }}
        />
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <div style={{ position: "relative" }}>
            <button
              ref={plusBtnRef}
              type="button"
              className="rv-btn rv-btn-icon"
              data-variant="ghost"
              data-active={plusOpen}
              title="Add"
              aria-label="Add"
              onClick={() => setPlusOpen((v) => !v)}
              style={{ fontSize: 20, lineHeight: 1 }}
            >
              ＋
            </button>
            {plusOpen && (
              <div
                ref={plusMenuRef}
                className="rv-menu rv-fade-in"
                style={{
                  position: "absolute",
                  bottom: "calc(100% + var(--s-2))",
                  left: 0,
                  minWidth: 190,
                  zIndex: 46,
                  padding: "var(--s-1)",
                }}
              >
                <button
                  type="button"
                  className="rv-menu-item"
                  disabled={!attachmentsAllowed || uploading}
                  title={attachmentsAllowed ? undefined : "Not available in encrypted DMs"}
                  onClick={() => {
                    if (!attachmentsAllowed) return;
                    setPlusOpen(false);
                    attachInputRef.current?.click();
                  }}
                  style={{
                    ...PLUS_ITEM_STYLE,
                    ...(attachmentsAllowed && !uploading ? {} : { opacity: 0.45, cursor: "not-allowed" }),
                  }}
                >
                  <span aria-hidden style={{ width: 18 }}>📎</span> Upload a File
                </button>
                <button
                  type="button"
                  className="rv-menu-item"
                  disabled={!attachmentsAllowed}
                  title={attachmentsAllowed ? undefined : "Not available in encrypted DMs"}
                  onClick={() => {
                    if (!attachmentsAllowed) return;
                    setPlusOpen(false);
                    setPollOpen(true);
                  }}
                  style={{
                    ...PLUS_ITEM_STYLE,
                    ...(attachmentsAllowed ? {} : { opacity: 0.45, cursor: "not-allowed" }),
                  }}
                >
                  <span aria-hidden style={{ width: 18 }}>📊</span> Create Poll
                </button>
              </div>
            )}
          </div>
          <div style={{ position: "relative", flex: 1 }}>
            <input
              ref={inputRef}
              className="rv-input"
              placeholder={channelName ? `Message #${channelName}…` : "Message…"}
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
            ref={emojiBtnRef}
            type="button"
            className="rv-btn rv-btn-icon"
            data-variant="ghost"
            onClick={() => setEmojiOpen((o) => !o)}
            aria-label="Emoji"
            data-active={emojiOpen}
          >
            <I.Smile size={16} />
          </button>
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
              // Toast only after the write resolves — a denied/unfocused
              // clipboard must not flash a false "copied".
              void navigator.clipboard
                .writeText(msgMenu.body)
                .then(() => pushToast({ kind: "success", text: "Message copied" }))
                .catch(() => pushToast({ kind: "error", text: "Couldn't copy message" }));
              setMsgMenu(null);
            }}
          />
          <MenuItem
            icon="📌"
            label={msgMenu.pinned ? "Unpin" : "Pin message"}
            onClick={() => {
              const { id, pinned } = msgMenu;
              setMsgMenu(null);
              const call = pinned
                ? apiRef.current?.unpinChatMessage(id)
                : apiRef.current?.pinChatMessage(id);
              void call
                ?.then(() => {
                  setMessages((prev) =>
                    prev.map((m) =>
                      m.id === id ? { ...m, pinnedAt: pinned ? null : new Date().toISOString() } : m,
                    ),
                  );
                  setPins(null); // refetch on next open
                })
                .catch((e: unknown) => setError(e instanceof Error ? e.message : "failed"));
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
                label={deleteArmed ? "Sure? This deletes it for everyone" : "Delete message"}
                tone="danger"
                onClick={() => {
                  if (!deleteArmed) {
                    setDeleteArmed(true);
                    return;
                  }
                  const id = msgMenu.id;
                  setMsgMenu(null);
                  setDeleteArmed(false);
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

// Day divider between messages from different days (deck 2.4 thread body).
function DayDivider({ iso }: { iso: string }): ReactElement {
  const d = new Date(iso);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  const label =
    d.toDateString() === today.toDateString()
      ? "Today"
      : d.toDateString() === yesterday.toDateString()
        ? "Yesterday"
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        margin: "var(--s-2) 0",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-2xs)",
        letterSpacing: ".14em",
        textTransform: "uppercase",
        color: "var(--text-faint)",
      }}
    >
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
      {label}
      <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
    </div>
  );
}

// Accent "new messages" marker — distinct from the neutral DayDivider so an
// unread boundary reads at a glance.
function NewMessagesDivider({ count }: { count: number }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        margin: "var(--s-2) 0",
        fontFamily: "var(--font-mono)",
        fontSize: "var(--t-2xs)",
        letterSpacing: ".14em",
        textTransform: "uppercase",
        color: "var(--accent)",
      }}
    >
      <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--accent) 45%, transparent)" }} />
      {count > 0 ? `${count} new` : "new"}
      <span style={{ flex: 1, height: 1, background: "color-mix(in srgb, var(--accent) 45%, transparent)" }} />
    </div>
  );
}

// Loading placeholder — three shimmering rows so an in-flight history fetch
// never masquerades as an empty thread.
function ChatHistorySkeleton(): ReactElement {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", padding: "var(--s-2) 0" }} aria-hidden>
      {[0, 1, 2].map((i) => (
        <div key={i} style={{ display: "flex", flexDirection: i === 1 ? "row-reverse" : "row", gap: "var(--s-2)", alignItems: "flex-end" }}>
          <div className="rv-skeleton" style={{ width: 30, height: 30, borderRadius: "50%", flexShrink: 0 }} />
          <div className="rv-skeleton" style={{ width: `${55 - i * 8}%`, height: "2.2rem", borderRadius: 14 }} />
        </div>
      ))}
    </div>
  );
}

// Optimistic outbound bubble — greyed while sending, retryable on failure.
function PendingBubble({
  item,
  onRetry,
  onDiscard,
}: {
  item: PendingMessage;
  onRetry: () => void;
  onDiscard: () => void;
}): ReactElement {
  const failed = item.status === "failed";
  return (
    <div style={{ display: "flex", flexDirection: "row-reverse", alignItems: "flex-end", gap: "var(--s-2)" }}>
      <div style={{ width: 30, flexShrink: 0 }} />
      <div style={{ display: "flex", flexDirection: "column", gap: 3, maxWidth: "78%", alignItems: "flex-end" }}>
        <div
          style={{
            padding: "8px 13px",
            borderRadius: 14,
            fontSize: "var(--t-sm)",
            lineHeight: 1.5,
            wordBreak: "break-word",
            background: "var(--bubble-me)",
            color: "#fff",
            border: failed ? "1px solid var(--danger)" : "1px solid var(--bubble-me)",
            opacity: failed ? 0.7 : 0.55,
          }}
        >
          {item.text}
        </div>
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-2xs)",
            color: failed ? "var(--danger)" : "var(--text-faint)",
          }}
        >
          {failed ? (
            <>
              <span>failed to send</span>
              <button type="button" onClick={onRetry} style={pendingActionStyle}>
                retry
              </button>
              <button type="button" onClick={onDiscard} style={pendingActionStyle} aria-label="Discard message">
                ✕
              </button>
            </>
          ) : (
            "sending…"
          )}
        </div>
      </div>
    </div>
  );
}

const pendingActionStyle: CSSProperties = {
  appearance: "none",
  background: "transparent",
  border: 0,
  padding: 0,
  font: "inherit",
  color: "inherit",
  cursor: "pointer",
  textDecoration: "underline",
  textUnderlineOffset: 2,
};

// Deck 2.4 message row: 32px avatar beside the stack, mine reversed with
// the ink bubble, theirs white with a hairline; follow-ups from the same
// author drop the name/time + avatar and tighten up.
const QUICK_REACTIONS = ["👍", "❤️", "😂"];

// 2.5o slash commands — text transforms applied at send time.
const SLASH_COMMANDS: Array<{ cmd: string; hint: string; apply: (rest: string) => string }> = [
  { cmd: "/shrug", hint: "appends ¯\\_(ツ)_/¯", apply: (rest) => `${rest} ¯\\_(ツ)_/¯`.trim() },
  { cmd: "/tableflip", hint: "appends (╯°□°)╯︵ ┻━┻", apply: (rest) => `${rest} (╯°□°)╯︵ ┻━┻`.trim() },
  { cmd: "/unflip", hint: "appends ┬─┬ノ( º _ ºノ)", apply: (rest) => `${rest} ┬─┬ノ( º _ ºノ)`.trim() },
  { cmd: "/lenny", hint: "appends ( ͡° ͜ʖ ͡°)", apply: (rest) => `${rest} ( ͡° ͜ʖ ͡°)`.trim() },
];

function applySlashCommand(text: string): string {
  if (!text.startsWith("/")) return text;
  const space = text.indexOf(" ");
  const cmd = space === -1 ? text : text.slice(0, space);
  const rest = space === -1 ? "" : text.slice(space + 1);
  const found = SLASH_COMMANDS.find((c) => c.cmd === cmd);
  return found ? found.apply(rest) : text;
}

// Memoized so a composer keystroke (which re-renders the panel) doesn't re-run
// renderRichBody's regex parse across every message. The callbacks take their
// own `msg` so the parent can pass stable references and the memo actually holds.
const ChatBubble = memo(function ChatBubble({
  msg,
  me,
  followup,
  onContextMenu,
  onToggleReaction,
  onVote,
}: {
  msg: ChatMessageDTO;
  me: boolean;
  followup: boolean;
  onContextMenu?: (msg: ChatMessageDTO, x: number, y: number) => void;
  onToggleReaction?: (msg: ChatMessageDTO, emoji: string, mine: boolean) => void;
  onVote?: (msg: ChatMessageDTO, optionId: string) => void;
}): ReactElement {
  const [hovered, setHovered] = useState(false);
  // Arbitrary-emoji reaction picker, opened from the hover menu's "＋".
  // Fixed-positioned (anchored to the button rect) so the emoji panel never
  // gets clipped by the scroll container.
  const [reactPos, setReactPos] = useState<{ x: number; y: number } | null>(null);
  const reactWrapRef = useRef<HTMLDivElement>(null);
  const reactBtnRef = useRef<HTMLButtonElement>(null);
  useDismiss(reactPos !== null, () => setReactPos(null), [reactWrapRef, reactBtnRef]);
  const time = new Date(msg.createdAt).toLocaleTimeString(undefined, {
    hour: "2-digit",
    minute: "2-digit",
  });
  const deleted = msg.deletedAt !== null || msg.body === null;
  // A room message may carry only an attachment or a poll (empty body). Skip the
  // text bubble in that case so an empty grey pill never renders (#29/#30).
  const attachments = deleted ? [] : msg.attachments ?? [];
  const poll = deleted ? null : msg.poll ?? null;
  const bodyText = msg.body ?? "";
  const showTextBubble = deleted || bodyText.trim().length > 0;
  return (
    <div
      onContextMenu={(e) => {
        if (!onContextMenu) return;
        e.preventDefault();
        onContextMenu(msg, e.clientX, e.clientY);
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      style={{
        display: "flex",
        flexDirection: me ? "row-reverse" : "row",
        alignItems: "flex-end",
        gap: "var(--s-2)",
        marginTop: followup ? -6 : 0,
        position: "relative",
      }}
    >
      {/* 2.5k hover reactions: quick set + arbitrary-emoji picker */}
      {(hovered || reactPos !== null) && !deleted && onToggleReaction && (
        <div
          style={{
            position: "absolute",
            top: -14,
            // Sit on the bubble's own side (row is full-width): me's bubble is
            // on the right, theirs on the left. Was inverted → the bar floated
            // off to the opposite edge of the app.
            [me ? "right" : "left"]: 40,
            display: "flex",
            gap: 2,
            background: "var(--bg-elev)",
            border: "1px solid var(--border)",
            borderRadius: 999,
            padding: "2px 6px",
            boxShadow: "var(--shadow-1)",
            zIndex: 5,
          }}
        >
          {QUICK_REACTIONS.map((e) => {
            const mine = msg.reactions?.find((r) => r.emoji === e)?.mine ?? false;
            return (
              <button
                key={e}
                type="button"
                onClick={() => onToggleReaction(msg, e, mine)}
                style={{
                  appearance: "none",
                  background: mine ? "var(--accent-tint)" : "transparent",
                  border: 0,
                  borderRadius: 999,
                  padding: "1px 4px",
                  fontSize: 14,
                  cursor: "pointer",
                  lineHeight: 1.2,
                }}
              >
                {e}
              </button>
            );
          })}
          <button
            ref={reactBtnRef}
            type="button"
            title="More reactions"
            aria-label="More reactions"
            onClick={() => {
              if (reactPos) {
                setReactPos(null);
                return;
              }
              const r = reactBtnRef.current?.getBoundingClientRect();
              if (r) {
                setReactPos({
                  x: Math.max(8, Math.min(r.left, window.innerWidth - 312)),
                  y: Math.min(r.bottom + 4, window.innerHeight - 380),
                });
              }
            }}
            style={{
              appearance: "none",
              background: reactPos ? "var(--accent-tint)" : "transparent",
              border: 0,
              borderRadius: 999,
              padding: "1px 4px",
              fontSize: 13,
              cursor: "pointer",
              lineHeight: 1.2,
              color: "var(--text-mid)",
            }}
          >
            ＋
          </button>
        </div>
      )}
      {reactPos !== null && !deleted && onToggleReaction && (
        <div ref={reactWrapRef} className="rv-reaction-pop" style={{ left: reactPos.x, top: reactPos.y }}>
          <EmojiPicker
            embedded
            onPick={(emoji) => {
              const mine = msg.reactions?.find((r) => r.emoji === emoji)?.mine ?? false;
              onToggleReaction(msg, emoji, mine);
              setReactPos(null);
            }}
          />
        </div>
      )}
      <div style={{ flexShrink: 0, visibility: followup ? "hidden" : "visible", marginBottom: 2 }}>
        <Avatar src={null} fallbackInitials={msg.authorName} fallbackColorSeed={msg.authorId} size={30} />
      </div>
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
        {showTextBubble && (
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
            {deleted ? "(deleted)" : renderRichBody(bodyText, (msg.mentions?.length ?? 0) > 0, me)}
          </div>
        )}
        {attachments.length > 0 && <AttachmentList attachments={attachments} me={me} />}
        {poll && (
          <PollCard
            poll={poll}
            onVote={onVote ? (optionId) => onVote(msg, optionId) : undefined}
          />
        )}
        {/* Reaction chips — click to toggle; mine = Cherry-tinted */}
        {(msg.reactions?.length ?? 0) > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 1 }}>
            {msg.reactions!.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onToggleReaction?.(msg, r.emoji, r.mine)}
                title={r.mine ? "Remove your reaction" : "React too"}
                style={{
                  appearance: "none",
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 4,
                  padding: "1px 7px",
                  borderRadius: 999,
                  border: r.mine
                    ? "1px solid color-mix(in srgb, var(--accent) 45%, var(--border))"
                    : "1px solid var(--border)",
                  background: r.mine ? "var(--accent-tint)" : "var(--bg-elev)",
                  fontSize: 12,
                  cursor: "pointer",
                  color: "var(--text)",
                }}
              >
                {r.emoji}
                <span className="rv-mono" style={{ fontSize: 10, color: "var(--text-mid)" }}>{r.count}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </div>
  );
});

// #30 message attachments — images render inline (click to open full size),
// everything else as a compact download card.
function AttachmentList({ attachments, me }: { attachments: MessageAttachment[]; me: boolean }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-2)",
        alignItems: me ? "flex-end" : "flex-start",
        maxWidth: "100%",
      }}
    >
      {attachments.map((a) => {
        if (a.mime.startsWith("image/")) {
          return (
            <a
              key={a.url}
              href={a.url}
              target="_blank"
              rel="noreferrer noopener"
              style={{ display: "block", maxWidth: 320, lineHeight: 0 }}
            >
              <img
                src={a.url}
                alt={a.name}
                style={{
                  maxWidth: 320,
                  maxHeight: 320,
                  width: "auto",
                  height: "auto",
                  borderRadius: 12,
                  display: "block",
                  border: "1px solid var(--border-soft)",
                }}
              />
            </a>
          );
        }
        // In-app video player — play mp4/webm inline instead of a download card.
        if (a.mime.startsWith("video/")) {
          return (
            <video
              key={a.url}
              src={a.url}
              controls
              preload="metadata"
              style={{
                maxWidth: 360,
                width: "100%",
                maxHeight: 340,
                borderRadius: 12,
                border: "1px solid var(--border-soft)",
                background: "#000",
                display: "block",
              }}
            />
          );
        }
        // Inline audio player.
        if (a.mime.startsWith("audio/")) {
          return (
            <audio key={a.url} src={a.url} controls preload="metadata" style={{ maxWidth: 320, width: "100%" }} />
          );
        }
        return (
          <a
            key={a.url}
            href={a.url}
            target="_blank"
            rel="noreferrer noopener"
            download={a.name}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              maxWidth: 320,
              padding: "var(--s-2) var(--s-3)",
              borderRadius: "var(--r-md)",
              border: "1px solid var(--border)",
              background: "var(--bg-elev)",
              textDecoration: "none",
              color: "var(--text)",
            }}
          >
            <span aria-hidden style={{ fontSize: 20, lineHeight: 1, flexShrink: 0 }}>
              {fileGlyph(a.mime)}
            </span>
            <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span
                style={{
                  fontSize: "var(--t-xs)",
                  fontWeight: 600,
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {a.name}
              </span>
              <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                {humanSize(a.size)}
              </span>
            </span>
          </a>
        );
      })}
    </div>
  );
}

// #29 poll card — click a bar to vote; the bar fill is proportional to the
// leading option, the caller's pick is highlighted, re-clicking retracts.
function PollCard({ poll, onVote }: { poll: PollDTO; onVote?: ((optionId: string) => void) | undefined }): ReactElement {
  const counts = poll.options.map((o) => poll.tally[o.id] ?? 0);
  const max = Math.max(1, ...counts);
  return (
    <div
      style={{
        width: "100%",
        minWidth: 220,
        maxWidth: 320,
        padding: "var(--s-3)",
        borderRadius: 14,
        border: "1px solid var(--border)",
        background: "var(--bg-elev)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 6,
          fontWeight: 700,
          fontSize: "var(--t-sm)",
          marginBottom: "var(--s-2)",
          wordBreak: "break-word",
        }}
      >
        <span aria-hidden style={{ flexShrink: 0 }}>📊</span>
        <span>{poll.question}</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
        {poll.options.map((opt) => {
          const count = poll.tally[opt.id] ?? 0;
          const pct = (count / max) * 100;
          const voted = poll.myVote === opt.id;
          return (
            <button
              key={opt.id}
              type="button"
              onClick={() => onVote?.(opt.id)}
              disabled={!onVote}
              style={{
                position: "relative",
                overflow: "hidden",
                appearance: "none",
                textAlign: "left",
                padding: "6px 10px",
                borderRadius: 8,
                border: voted
                  ? "1px solid color-mix(in srgb, var(--accent) 55%, var(--border))"
                  : "1px solid var(--border)",
                background: "var(--bg)",
                color: "var(--text)",
                cursor: onVote ? "pointer" : "default",
                font: "inherit",
                fontSize: "var(--t-xs)",
              }}
            >
              <span
                aria-hidden
                style={{
                  position: "absolute",
                  insetBlock: 0,
                  insetInlineStart: 0,
                  width: `${pct}%`,
                  background: voted
                    ? "color-mix(in srgb, var(--accent) 32%, transparent)"
                    : "color-mix(in srgb, var(--accent) 16%, transparent)",
                  transition: "width var(--d-mid, .2s) var(--ease-out, ease)",
                  zIndex: 0,
                }}
              />
              <span
                style={{
                  position: "relative",
                  zIndex: 1,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "space-between",
                  gap: "var(--s-2)",
                }}
              >
                <span style={{ display: "flex", alignItems: "center", gap: 6, minWidth: 0 }}>
                  {voted && <span aria-hidden style={{ color: "var(--accent)" }}>✓</span>}
                  <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {opt.text}
                  </span>
                </span>
                <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)", flexShrink: 0 }}>
                  {count}
                </span>
              </span>
            </button>
          );
        })}
      </div>
      <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)", marginTop: "var(--s-2)" }}>
        {poll.totalVotes} vote{poll.totalVotes === 1 ? "" : "s"}
      </div>
    </div>
  );
}

// 2.5m emoji picker — search, category tabs (deck: 🕒😀🐱🍔⚽🚗💡🎵🚩),
// stacked sections, and a preview foot (emoji + name + :shortcode:).
// Static curated set; [emoji, name] pairs drive search + the preview.
type EmojiEntry = readonly [string, string];

const EMOJI_CATEGORIES: ReadonlyArray<{ id: string; icon: string; label: string; emojis: readonly EmojiEntry[] }> = [
  {
    id: "recent", icon: "🕒", label: "Frequently used",
    emojis: [
      ["👍", "Thumbs up"], ["❤️", "Red heart"], ["😂", "Tears of joy"], ["🔥", "Fire"],
      ["✨", "Sparkles"], ["👀", "Eyes"], ["🙏", "Folded hands"], ["💯", "Hundred"],
      ["😅", "Sweat smile"], ["🤔", "Thinking"], ["😎", "Cool"], ["🚀", "Rocket"],
      ["👻", "Ghost"], ["🫡", "Salute"], ["🥲", "Tearful smile"], ["😭", "Loudly crying"],
    ],
  },
  {
    id: "smileys", icon: "😀", label: "Smileys & people",
    emojis: [
      ["😀", "Grinning"], ["😃", "Big smile"], ["😄", "Smiling eyes"], ["😁", "Beaming"],
      ["😆", "Laughing"], ["🥹", "Holding back tears"], ["😉", "Wink"], ["😊", "Blush"],
      ["🙂", "Slight smile"], ["😇", "Halo"], ["🥰", "Hearts face"], ["😍", "Heart eyes"],
      ["🤩", "Star struck"], ["😘", "Blowing kiss"], ["😜", "Winking tongue"], ["🤪", "Zany"],
      ["🤗", "Hugging"], ["🤭", "Hand over mouth"], ["🤫", "Shushing"], ["😐", "Neutral"],
      ["😴", "Sleeping"], ["🥱", "Yawning"], ["😷", "Mask"], ["🥵", "Hot face"],
      ["🥶", "Cold face"], ["😱", "Screaming"], ["😤", "Steam nose"], ["😡", "Angry"],
      ["🤬", "Cursing"], ["🥺", "Pleading"], ["💀", "Skull"], ["🤡", "Clown"],
    ],
  },
  {
    id: "gestures", icon: "👋", label: "Gestures",
    emojis: [
      ["👋", "Waving hand"], ["🤚", "Raised back of hand"], ["✋", "Raised hand"], ["🖖", "Vulcan salute"],
      ["👌", "OK hand"], ["🤌", "Pinched fingers"], ["✌️", "Victory"], ["🤞", "Crossed fingers"],
      ["🤟", "Love you"], ["🤘", "Rock on"], ["👈", "Point left"], ["👉", "Point right"],
      ["👆", "Point up"], ["👇", "Point down"], ["👎", "Thumbs down"], ["✊", "Raised fist"],
      ["🤛", "Left fist"], ["🤜", "Right fist"], ["👏", "Clapping"], ["🙌", "Raised hands"],
      ["🤝", "Handshake"], ["💪", "Flexed biceps"], ["🖐️", "Splayed hand"], ["🫶", "Heart hands"],
    ],
  },
  {
    id: "animals", icon: "🐱", label: "Animals & nature",
    emojis: [
      ["🐶", "Dog"], ["🐱", "Cat"], ["🐭", "Mouse"], ["🐹", "Hamster"],
      ["🐰", "Rabbit"], ["🦊", "Fox"], ["🐻", "Bear"], ["🐼", "Panda"],
      ["🐨", "Koala"], ["🐯", "Tiger"], ["🦁", "Lion"], ["🐸", "Frog"],
      ["🐵", "Monkey"], ["🐧", "Penguin"], ["🦉", "Owl"], ["🦄", "Unicorn"],
      ["🐝", "Bee"], ["🦋", "Butterfly"], ["🐢", "Turtle"], ["🐙", "Octopus"],
      ["🌸", "Cherry blossom"], ["🌵", "Cactus"], ["🌲", "Evergreen"], ["🌈", "Rainbow"],
    ],
  },
  {
    id: "food", icon: "🍔", label: "Food & drink",
    emojis: [
      ["🍎", "Apple"], ["🍌", "Banana"], ["🍉", "Watermelon"], ["🍓", "Strawberry"],
      ["🍒", "Cherries"], ["🥑", "Avocado"], ["🌽", "Corn"], ["🍕", "Pizza"],
      ["🍔", "Burger"], ["🍟", "Fries"], ["🌭", "Hot dog"], ["🌮", "Taco"],
      ["🍣", "Sushi"], ["🍜", "Ramen"], ["🍩", "Doughnut"], ["🍪", "Cookie"],
      ["🎂", "Birthday cake"], ["🍿", "Popcorn"], ["🥨", "Pretzel"], ["🧀", "Cheese"],
      ["☕", "Coffee"], ["🧋", "Bubble tea"], ["🍺", "Beer"], ["🥂", "Clinking glasses"],
    ],
  },
  {
    id: "activities", icon: "⚽", label: "Activities",
    emojis: [
      ["⚽", "Soccer ball"], ["🏀", "Basketball"], ["🏈", "Football"], ["⚾", "Baseball"],
      ["🎾", "Tennis"], ["🏐", "Volleyball"], ["🎱", "8 ball"], ["🏓", "Ping pong"],
      ["🥊", "Boxing glove"], ["⛳", "Golf"], ["🎣", "Fishing"], ["🛹", "Skateboard"],
      ["🎮", "Video game"], ["🕹️", "Joystick"], ["🎲", "Die"], ["🎯", "Bullseye"],
      ["🎳", "Bowling"], ["🎤", "Microphone"], ["🎧", "Headphones"], ["🎸", "Guitar"],
      ["🥁", "Drum"], ["🎹", "Keyboard"], ["🏆", "Trophy"], ["🎉", "Party popper"],
    ],
  },
  {
    id: "travel", icon: "🚗", label: "Travel & places",
    emojis: [
      ["🚗", "Car"], ["🚕", "Taxi"], ["🚌", "Bus"], ["🏎️", "Race car"],
      ["🚓", "Police car"], ["🚑", "Ambulance"], ["🚒", "Fire engine"], ["🛵", "Scooter"],
      ["🚲", "Bicycle"], ["🚂", "Locomotive"], ["✈️", "Airplane"], ["🛸", "UFO"],
      ["🚁", "Helicopter"], ["⛵", "Sailboat"], ["🗽", "Statue of Liberty"], ["🗼", "Tokyo tower"],
      ["🏰", "Castle"], ["🏝️", "Desert island"], ["🏔️", "Snowy mountain"], ["🌋", "Volcano"],
      ["🏟️", "Stadium"], ["🌃", "Night city"], ["🗺️", "World map"], ["🧭", "Compass"],
    ],
  },
  {
    id: "objects", icon: "💡", label: "Objects",
    emojis: [
      ["💡", "Light bulb"], ["🔦", "Flashlight"], ["🕯️", "Candle"], ["💻", "Laptop"],
      ["🖥️", "Desktop"], ["🖱️", "Mouse"], ["⌨️", "Keyboard"], ["📱", "Phone"],
      ["📷", "Camera"], ["🎥", "Movie camera"], ["📺", "Television"], ["📻", "Radio"],
      ["⏰", "Alarm clock"], ["⌚", "Watch"], ["🔋", "Battery"], ["🔌", "Plug"],
      ["🔧", "Wrench"], ["🔨", "Hammer"], ["🛠️", "Hammer and wrench"], ["🔑", "Key"],
      ["🔒", "Lock"], ["📌", "Pushpin"], ["📎", "Paperclip"], ["✂️", "Scissors"],
    ],
  },
  {
    id: "symbols", icon: "🎵", label: "Symbols & hearts",
    emojis: [
      ["❤️", "Red heart"], ["🧡", "Orange heart"], ["💛", "Yellow heart"], ["💚", "Green heart"],
      ["💙", "Blue heart"], ["💜", "Purple heart"], ["🖤", "Black heart"], ["🤍", "White heart"],
      ["💔", "Broken heart"], ["❣️", "Heart exclamation"], ["💕", "Two hearts"], ["💖", "Sparkling heart"],
      ["💘", "Heart with arrow"], ["💝", "Heart with ribbon"], ["🎵", "Music note"], ["🎶", "Music notes"],
      ["💤", "Zzz"], ["💢", "Anger"], ["💬", "Speech bubble"], ["✅", "Check mark"],
      ["❌", "Cross mark"], ["⚠️", "Warning"], ["♻️", "Recycle"], ["⭐", "Star"],
    ],
  },
  {
    id: "flags", icon: "🚩", label: "Flags",
    emojis: [
      ["🚩", "Triangular flag"], ["🏁", "Chequered flag"], ["🏳️", "White flag"], ["🏴", "Black flag"],
      ["🏳️‍🌈", "Rainbow flag"], ["🏴‍☠️", "Pirate flag"], ["🇺🇸", "USA"], ["🇬🇧", "UK"],
      ["🇨🇦", "Canada"], ["🇩🇪", "Germany"], ["🇫🇷", "France"], ["🇯🇵", "Japan"],
      ["🇰🇷", "South Korea"], ["🇧🇷", "Brazil"], ["🇦🇺", "Australia"], ["🇸🇪", "Sweden"],
    ],
  },
];

function shortcodeOf(name: string): string {
  return `:${name.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_|_$/g, "")}:`;
}

function EmojiPicker({ onPick, embedded = false }: { onPick: (e: string) => void; embedded?: boolean }): ReactElement {
  const [query, setQuery] = useState("");
  const [activeTab, setActiveTab] = useState("recent");
  const [preview, setPreview] = useState<EmojiEntry>(["🎉", "Party popper"]);
  const sectionRefs = useRef<Record<string, HTMLDivElement | null>>({});

  const q = query.trim().toLowerCase();
  const matches = q
    ? EMOJI_CATEGORIES.flatMap((c) => c.emojis.filter(([ch, name]) => name.toLowerCase().includes(q) || ch === q))
    : [];

  const cell = ([ch, name]: EmojiEntry): ReactElement => (
    <button
      key={`${ch}-${name}`}
      type="button"
      className="rv-ep-cell"
      title={name}
      onMouseEnter={() => setPreview([ch, name])}
      onClick={() => onPick(ch)}
    >
      {ch}
    </button>
  );

  return (
    <div className="rv-ep" data-embed={embedded ? "true" : undefined}>
      <div className="rv-ep-search">
        <input
          className="rv-input"
          aria-label="Search emoji"
          placeholder="Search emoji…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          style={{ height: "1.9rem", fontSize: "var(--t-xs)" }}
        />
      </div>
      <div className="rv-ep-tabs">
        {EMOJI_CATEGORIES.map((c) => (
          <button
            key={c.id}
            type="button"
            className="rv-ep-tab"
            data-active={activeTab === c.id && !q}
            title={c.label}
            onClick={() => {
              setQuery("");
              setActiveTab(c.id);
              sectionRefs.current[c.id]?.scrollIntoView({ block: "start" });
            }}
          >
            {c.icon}
          </button>
        ))}
      </div>
      <div className="rv-ep-body rv-scroll">
        {q ? (
          <>
            <div className="rv-ep-section">Search · &quot;{query.trim()}&quot;</div>
            {matches.length === 0 ? (
              <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)", padding: "var(--s-2)" }}>
                No emoji match.
              </div>
            ) : (
              <div className="rv-ep-grid">{matches.map(cell)}</div>
            )}
          </>
        ) : (
          EMOJI_CATEGORIES.map((c) => (
            <div
              key={c.id}
              ref={(el) => {
                sectionRefs.current[c.id] = el;
              }}
            >
              <div className="rv-ep-section">{c.label}</div>
              <div className="rv-ep-grid">{c.emojis.map(cell)}</div>
            </div>
          ))
        )}
      </div>
      <div className="rv-ep-foot">
        <span className="preview">{preview[0]}</span>
        <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
          <span className="name">{preview[1]}</span>
          <span className="colon">{shortcodeOf(preview[1])}</span>
        </div>
      </div>
    </div>
  );
}

