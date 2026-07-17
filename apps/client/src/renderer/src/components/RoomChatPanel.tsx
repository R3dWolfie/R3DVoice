import { useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import type { ChatMessageDTO } from "@r3dvoice/shared";
import { ApiClient } from "../lib/api.js";
import { ensureTransport, setCurrentlyViewingThread, type ChatTransport } from "../lib/chat-transport.js";
import { useAuthStore } from "../lib/auth-context.js";
import { decryptDM, encryptDM, type EncryptedDMPayload } from "../lib/crypto.js";
import { loadKeyPair } from "../lib/key-storage.js";
import { Avatar } from "./Avatar.js";
import { useDismiss } from "../lib/use-dismiss.js";
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
  const emojiWrapRef = useRef<HTMLDivElement>(null);
  const emojiBtnRef = useRef<HTMLButtonElement>(null);
  useDismiss(emojiOpen, () => setEmojiOpen(false), [emojiWrapRef, emojiBtnRef]);
  const [mentionQuery, setMentionQuery] = useState<string | null>(null);
  const [mentionAnchor, setMentionAnchor] = useState<number>(0);
  const [error, setError] = useState<string | null>(null);
  // 2.5k message context menu + edit-in-composer state.
  const [msgMenu, setMsgMenu] = useState<{ id: string; x: number; y: number; body: string; mine: boolean; pinned: boolean } | null>(null);
  const [pinsOpen, setPinsOpen] = useState(false);
  const [pins, setPins] = useState<ChatMessageDTO[] | null>(null);
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
  // Scroll-up pagination: history loads 50 at a time; reaching the top
  // fetches the previous page and preserves the scroll position.
  const [hasMore, setHasMore] = useState(true);
  const loadingOlderRef = useRef(false);
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
        if (!cancelled) {
          setMessages(res.messages);
          setHasMore(res.messages.length >= 50);
        }
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
      } else if (event.type === "pinned") {
        if (event.message.threadType === threadType && event.message.threadId === threadId) {
          setMessages((prev) => prev.map((m) => (m.id === event.message.id ? event.message : m)));
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

  // Auto-scroll on new message (only if user is near the bottom).
  useEffect(() => {
    const el = listRef.current;
    if (!el) return;
    const nearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    if (nearBottom) el.scrollTop = el.scrollHeight;
  }, [messages]);

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
      const plain = decryptDM(payload, myKeyPair, peerPublicKey ?? undefined);
      if (plain === null) return { ...m, body: "🔒 Sent before this device had your key" };
      return { ...m, body: plain };
    });
  }, [messages, threadType, myKeyPair, peerPublicKey]);

  // Deleted messages vanish from the stream (Discord semantics) instead of
  // leaving tombstone rows that read as blank gaps.
  const visible = useMemo(() => decrypted.filter((m) => m.deletedAt === null), [decrypted]);

  const insertEmoji = (e: string): void => {
    setDraft((d) => d + e);
    inputRef.current?.focus();
  };

  // 2.5k reactions — optimistic toggle; the WS echo is deduped by the
  // mine-guards in the event handler.
  const toggleReaction = (messageId: string, emoji: string, mine: boolean): void => {
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
              position: "relative",
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
        {visible.length === 0 ? (
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
          visible.map((m, i) => {
            const prev = i > 0 ? visible[i - 1]! : null;
            const dayChanged =
              prev === null ||
              new Date(prev.createdAt).toDateString() !== new Date(m.createdAt).toDateString();
            return (
              <div key={m.id} style={{ display: "contents" }}>
                {dayChanged && <DayDivider iso={m.createdAt} />}
                <ChatBubble
                  msg={m}
                  me={m.authorId === localIdentity}
                  followup={!dayChanged && prev !== null && prev.authorId === m.authorId}
                  onToggleReaction={(emoji, mine) => toggleReaction(m.id, emoji, mine)}
                  onContextMenu={(x, y) =>
                    setMsgMenu({
                      id: m.id,
                      x,
                      y,
                      body: m.body ?? "",
                      mine: m.authorId === localIdentity && m.deletedAt === null,
                      pinned: (m.pinnedAt ?? null) !== null,
                    })
                  }
                />
              </div>
            );
          })
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
        <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <button
            type="button"
            className="rv-btn rv-btn-icon"
            data-variant="ghost"
            data-disabled="true"
            title="Attachments are coming — not in this build yet."
            aria-label="Attach"
            style={{ opacity: 0.45, cursor: "default" }}
          >
            📎
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
              void navigator.clipboard.writeText(msgMenu.body).catch(() => {});
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

function ChatBubble({
  msg,
  me,
  followup,
  onContextMenu,
  onToggleReaction,
}: {
  msg: ChatMessageDTO;
  me: boolean;
  followup: boolean;
  onContextMenu?: (x: number, y: number) => void;
  onToggleReaction?: (emoji: string, mine: boolean) => void;
}): ReactElement {
  const [hovered, setHovered] = useState(false);
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
      {/* 2.5k hover quick-reactions */}
      {hovered && !deleted && onToggleReaction && (
        <div
          style={{
            position: "absolute",
            top: -14,
            [me ? "left" : "right"]: 40,
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
                onClick={() => onToggleReaction(e, mine)}
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
        {/* Reaction chips — click to toggle; mine = Cherry-tinted */}
        {(msg.reactions?.length ?? 0) > 0 && (
          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, marginTop: 1 }}>
            {msg.reactions!.map((r) => (
              <button
                key={r.emoji}
                type="button"
                onClick={() => onToggleReaction?.(r.emoji, r.mine)}
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

function EmojiPicker({ onPick }: { onPick: (e: string) => void }): ReactElement {
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
    <div className="rv-ep">
      <div className="rv-ep-search">
        <input
          className="rv-input"
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

