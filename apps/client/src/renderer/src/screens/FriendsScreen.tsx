import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { Avatar } from "../components/Avatar.js";
import { I } from "../components/Icons.js";
import { InviteCreateModal } from "../components/InviteCreateModal.js";
import { MyInvitesList } from "../components/MyInvitesList.js";
import { Modal } from "../components/Modal.js";

type Props = {
  onJoinRoom?: (roomId: string) => void;
  onOpenDms?: () => void;
};

// Friends page per WireFrames 2.2: top bar (title + counts, Add friend
// popover 2.2a, Invite links), pending-request banners, then friend rows
// with presence + "in <room>" join actions.
export function FriendsScreen({ onJoinRoom, onOpenDms }: Props = {}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [inviteCreateOpen, setInviteCreateOpen] = useState(false);
  const addRef = useRef<HTMLDivElement>(null);

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  }, [serverUrl, token]);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFor().friends();
      setFriends(r.friends);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load");
    }
  }, [apiFor]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    return t.on((event) => {
      if (
        event.type === "friend.request" ||
        event.type === "friend.accepted" ||
        event.type === "presence.update"
      ) {
        void refresh();
      }
    });
  }, [refresh]);

  useEffect(() => {
    if (!addOpen) return;
    function onDown(e: MouseEvent): void {
      if (addRef.current && !addRef.current.contains(e.target as Node)) setAddOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [addOpen]);

  const sendRequest = async (): Promise<void> => {
    const raw = addInput.trim();
    if (!raw) return;
    setBusy(true);
    setError(null);
    try {
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
      if (looksLikeEmail) {
        await apiFor().friendRequest(raw);
      } else {
        await apiFor().friendRequestByHandle(raw.replace(/^@/, ""));
      }
      setAddInput("");
      setAddOpen(false);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to send");
    } finally {
      setBusy(false);
    }
  };

  const accept = async (id: string): Promise<void> => {
    try {
      await apiFor().friendAccept(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };
  const reject = async (id: string): Promise<void> => {
    try {
      await apiFor().friendReject(id);
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    }
  };

  const incoming = friends.filter((f) => f.status === "pending-incoming");
  const outgoing = friends.filter((f) => f.status === "pending-outgoing");
  const accepted = friends.filter((f) => f.status === "accepted");
  const online = accepted.filter((f) => f.isOnline).length;

  return (
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100%", minHeight: 0 }}>
      {/* Top bar */}
      <div
        style={{
          height: "3.5rem",
          padding: "0 var(--s-6)",
          borderBottom: "1px solid var(--border-soft)",
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
        }}
      >
        <span style={{ fontSize: "var(--t-base)", fontWeight: 600 }}>
          Friends{" "}
          <span className="rv-mono" style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)", fontWeight: 500 }}>
            {accepted.length} · {online} online
          </span>
        </span>
        <span style={{ flex: 1 }} />
        <div ref={addRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            onClick={() => setAddOpen((v) => !v)}
            style={{ height: "2rem", fontSize: "var(--t-xs)" }}
          >
            <I.Plus size={13} /> Add friend
          </button>
          {addOpen && (
            <div
              className="rv-menu rv-fade-in"
              style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 290, padding: "var(--s-3)", zIndex: 40 }}
            >
              <div className="rv-label" style={{ marginBottom: "var(--s-2)", fontSize: "var(--t-2xs)" }}>
                Add by handle or email
              </div>
              <div style={{ display: "flex", gap: "var(--s-2)" }}>
                <input
                  autoFocus
                  className="rv-input"
                  placeholder="@handle or email"
                  value={addInput}
                  onChange={(e) => setAddInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") {
                      e.preventDefault();
                      void sendRequest();
                    }
                    if (e.key === "Escape") setAddOpen(false);
                  }}
                  disabled={busy}
                  style={{ height: "2rem", fontSize: "var(--t-xs)" }}
                />
                <button
                  type="button"
                  className="rv-btn"
                  data-variant="primary"
                  onClick={() => void sendRequest()}
                  disabled={busy || !addInput.trim()}
                  style={{ height: "2rem", padding: "0 var(--s-3)", fontSize: "var(--t-xs)" }}
                >
                  Send
                </button>
              </div>
            </div>
          )}
        </div>
        <button
          type="button"
          className="rv-btn"
          onClick={() => setInvitesOpen(true)}
          style={{ height: "2rem", fontSize: "var(--t-xs)" }}
        >
          🔗 Invite links
        </button>
      </div>

      {/* Body */}
      <div className="rv-scroll" style={{ overflow: "auto", minHeight: 0 }}>
        {error && (
          <div style={{ padding: "var(--s-3) var(--s-6) 0" }}>
            <div className="rv-err-banner" role="alert">
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          </div>
        )}

        {incoming.map((f) => (
          <div
            key={f.friendshipId}
            style={{
              margin: "var(--s-3) var(--s-6) 0",
              padding: "var(--s-3) var(--s-4)",
              background: "var(--accent-tint)",
              border: "1px solid color-mix(in srgb, var(--accent) 35%, var(--border))",
              borderRadius: "var(--r-md)",
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
            }}
          >
            <Avatar
              src={f.user.avatarUrl ?? null}
              fallbackInitials={f.user.displayName}
              fallbackColorSeed={f.user.id}
              size={36}
            />
            <div style={{ flex: 1, minWidth: 0, fontSize: "var(--t-sm)" }}>
              <b style={{ fontWeight: 600 }}>{f.user.displayName}</b>{" "}
              {f.user.handle && <span style={{ color: "var(--text-dim)", fontSize: "var(--t-xs)" }}>@{f.user.handle}</span>}{" "}
              wants to be your friend
            </div>
            <button
              className="rv-btn"
              data-variant="primary"
              style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
              onClick={() => void accept(f.friendshipId)}
            >
              Accept
            </button>
            <button
              className="rv-btn"
              style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
              onClick={() => void reject(f.friendshipId)}
            >
              Decline
            </button>
          </div>
        ))}

        <div style={{ padding: "var(--s-4) var(--s-4)" }}>
          {accepted.length === 0 && incoming.length === 0 ? (
            <div className="rv-empty" style={{ paddingTop: "var(--s-10)" }}>
              <span className="rv-empty-title">No friends yet</span>
              <span className="rv-empty-hint">Add someone by @handle, or send them a room invite link.</span>
            </div>
          ) : (
            accepted.map((f) => (
              <div
                key={f.friendshipId}
                className="rv-list-item"
                style={{ gridTemplateColumns: "auto 1fr auto", padding: "var(--s-3) var(--s-3)" }}
              >
                <div style={{ position: "relative" }}>
                  <Avatar
                    src={f.user.avatarUrl ?? null}
                    fallbackInitials={f.user.displayName}
                    fallbackColorSeed={f.user.id}
                    size={36}
                  />
                  <span
                    className="rv-status"
                    data-status={f.isOnline ? undefined : "offline"}
                    style={{ position: "absolute", bottom: -1, right: -1, border: "2px solid var(--bg)" }}
                  />
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: "var(--t-sm)", display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 500 }}>{f.user.displayName}</span>
                    {f.user.handle && (
                      <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                        @{f.user.handle}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
                    {f.user.currentRoom ? (
                      <>
                        in <span style={{ color: "var(--text)", fontWeight: 500 }}>{f.user.currentRoom.name}</span>
                      </>
                    ) : f.isOnline ? (
                      "online"
                    ) : (
                      "offline"
                    )}
                  </span>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)" }}>
                  {f.user.currentRoom && (
                    <button
                      className="rv-btn"
                      data-variant="primary"
                      style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
                      onClick={() => onJoinRoom?.(f.user.currentRoom!.id)}
                    >
                      Join room
                    </button>
                  )}
                  <button
                    className="rv-btn rv-btn-icon"
                    title="Send a DM"
                    style={{ height: "1.8rem", width: "1.8rem" }}
                    onClick={() => onOpenDms?.()}
                  >
                    <I.Chat size={13} />
                  </button>
                </div>
              </div>
            ))
          )}

          {outgoing.length > 0 && (
            <div style={{ marginTop: "var(--s-5)" }}>
              <div className="rv-label" style={{ marginBottom: "var(--s-2)", fontSize: "var(--t-2xs)" }}>
                Pending — sent
              </div>
              {outgoing.map((f) => (
                <div
                  key={f.friendshipId}
                  style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-sm)" }}
                >
                  <span style={{ flex: 1, color: "var(--text-dim)" }}>
                    {f.user.displayName}
                    {f.user.handle && <span className="rv-mono" style={{ fontSize: "var(--t-2xs)" }}> @{f.user.handle}</span>}
                  </span>
                  <button
                    className="rv-btn"
                    data-variant="ghost"
                    style={{ height: "1.7rem", fontSize: "var(--t-xs)" }}
                    onClick={() => void reject(f.friendshipId)}
                  >
                    Cancel
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>

      {/* Manage invite links (2.3 as a modal until it earns a page) */}
      <Modal
        open={invitesOpen}
        onClose={() => setInvitesOpen(false)}
        icon="🔗"
        title="Invite links"
        subtitle="Share a link — friends land in your room or your friend list."
        width="min(92vw, 560px)"
        footer={
          <>
            <span style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
              Links can expire or be single-use.
            </span>
            <button
              className="rv-btn"
              data-variant="primary"
              onClick={() => setInviteCreateOpen(true)}
            >
              <I.Plus size={13} /> Generate link
            </button>
          </>
        }
      >
        <div style={{ padding: "var(--s-4) var(--s-6)" }}>
          <MyInvitesList />
        </div>
      </Modal>
      <InviteCreateModal open={inviteCreateOpen} onClose={() => setInviteCreateOpen(false)} />
    </div>
  );
}
