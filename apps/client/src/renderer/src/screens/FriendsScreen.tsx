import { useCallback, useEffect, useRef, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { usePrefs } from "../lib/prefs-singleton.js";
import { Avatar } from "../components/Avatar.js";
import { ContextMenu, MenuItem, MenuDivider } from "../components/ContextMenu.js";
import { HandleMatchCard, useHandleMatch } from "../components/HandleMatchCard.js";
import { I } from "../components/Icons.js";
import { InviteCreateModal } from "../components/InviteCreateModal.js";
import { MyInvitesList } from "../components/MyInvitesList.js";
import { Modal } from "../components/Modal.js";
import { PeerProfilePopover } from "../components/PeerProfilePopover.js";
import { PresenceDot, formatLastSeen, type PresenceState } from "../components/presence.js";
import { UserContextMenu } from "../components/UserContextMenu.js";
import { useNotificationsStore } from "../lib/notifications-store.js";

type Props = {
  onJoinRoom?: (roomId: string) => void;
  onOpenDms?: (userId?: string) => void;
};

// Friends page per WireFrames 2.2: top bar (title + counts, Add friend
// popover 2.2a, Invite links), pending-request banners, then friend rows
// with presence + "in <room>" join actions.
export function FriendsScreen({ onJoinRoom, onOpenDms }: Props = {}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const me = useAuthStore((s) => s.user);
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const [addOpen, setAddOpen] = useState(false);
  const [addInput, setAddInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [invitesOpen, setInvitesOpen] = useState(false);
  const [inviteCreateOpen, setInviteCreateOpen] = useState(false);
  const [overflowOpen, setOverflowOpen] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ friend: FriendDTO; x: number; y: number } | null>(null);
  const [removeArmed, setRemoveArmed] = useState(false);
  // 2.4d full user menu (right-click / ⋮ on a friend row) + 2.4a profile.
  const [userMenu, setUserMenu] = useState<{
    x: number;
    y: number;
    user: { id: string; handle: string | null; displayName: string };
  } | null>(null);
  const [profilePeer, setProfilePeer] = useState<{ id: string; handle: string | null; displayName: string } | null>(null);
  const addRef = useRef<HTMLDivElement>(null);
  const overflowRef = useRef<HTMLDivElement>(null);
  const outgoingRef = useRef<HTMLDivElement>(null);
  const openSettingsKeybind = usePrefs((s) => s.openSettingsKeybind);
  // 2.2a — live match preview while the popover is open and a handle is typed.
  const addMatch = useHandleMatch(addOpen ? addInput : "");

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
        event.type === "friend.removed" ||
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

  useEffect(() => {
    if (!overflowOpen) return;
    function onDown(e: MouseEvent): void {
      if (overflowRef.current && !overflowRef.current.contains(e.target as Node)) setOverflowOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [overflowOpen]);

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
      void useNotificationsStore.getState().refresh();
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
    <div style={{ display: "grid", gridTemplateRows: "auto 1fr auto", height: "100%", minHeight: 0, position: "relative" }}>
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
        <span style={{ fontSize: "var(--t-lg)", fontWeight: 600 }}>
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
              style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 300, padding: "var(--s-3)", zIndex: 40 }}
            >
              {/* 2.2a head: icon plate + title/sub */}
              <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", marginBottom: "var(--s-3)" }}>
                <span
                  aria-hidden
                  style={{
                    width: 28,
                    height: 28,
                    borderRadius: "var(--r-md)",
                    background: "var(--bg-elev-2)",
                    border: "1px solid var(--border)",
                    display: "grid",
                    placeItems: "center",
                    fontWeight: 700,
                    color: "var(--text-mid)",
                    flexShrink: 0,
                  }}
                >
                  ＋
                </span>
                <span style={{ display: "flex", flexDirection: "column" }}>
                  <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>Add a friend</span>
                  <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>Type their @handle.</span>
                </span>
              </div>
              <div className="rv-label" style={{ marginBottom: "var(--s-2)", fontSize: "var(--t-2xs)" }}>
                @handle or email
              </div>
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
              {/* 2.2a — live match preview while typing a known handle */}
              {addMatch && (
                <div style={{ marginTop: "var(--s-2)" }}>
                  <HandleMatchCard match={addMatch} />
                </div>
              )}
              <div style={{ display: "flex", justifyContent: "flex-end", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
                <button
                  type="button"
                  className="rv-btn"
                  data-variant="ghost"
                  onClick={() => setAddOpen(false)}
                  style={{ height: "2rem", fontSize: "var(--t-xs)" }}
                >
                  Cancel
                </button>
                <button
                  type="button"
                  className="rv-btn"
                  data-variant="primary"
                  onClick={() => void sendRequest()}
                  disabled={busy || !addInput.trim()}
                  style={{ height: "2rem", padding: "0 var(--s-3)", fontSize: "var(--t-xs)" }}
                >
                  Send request
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
          <span style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
            <I.Link size={13} /> Invite links
          </span>
        </button>
        {/* 2.2 top-bar overflow (⋮): pending-sent + manage links */}
        <div ref={overflowRef} style={{ position: "relative" }}>
          <button
            type="button"
            className="rv-btn rv-btn-icon"
            title="More"
            aria-label="More"
            onClick={() => setOverflowOpen((v) => !v)}
            style={{ height: "2rem", width: "2rem", fontSize: "var(--t-md)", fontWeight: 700 }}
          >
            ⋮
          </button>
          {overflowOpen && (
            <div
              className="rv-menu rv-fade-in"
              style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 240, zIndex: 40 }}
            >
              <MenuItem
                label="Pending sent requests"
                kbd={String(outgoing.length)}
                disabled={outgoing.length === 0}
                disabledHint="No pending sent requests."
                onClick={() => {
                  setOverflowOpen(false);
                  outgoingRef.current?.scrollIntoView({ behavior: "smooth", block: "center" });
                }}
              />
              <MenuDivider />
              <MenuItem
                label="Manage invite links"
                onClick={() => {
                  setOverflowOpen(false);
                  setInvitesOpen(true);
                }}
              />
            </div>
          )}
        </div>
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
              // Deck 2.2: an incoming request is a POSITIVE prompt → green tint,
              // not the red accent used for alerts.
              background: "color-mix(in srgb, var(--ok) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--ok) 35%, var(--border))",
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
            accepted.map((f) => {
              // Prefer the server's coarse presence; fall back to the isOnline
              // boolean on older servers that don't send presenceState yet.
              const presenceState: PresenceState = f.presenceState ?? (f.isOnline ? "online" : "offline");
              return (
              <div
                key={f.friendshipId}
                className="rv-list-item"
                style={{ gridTemplateColumns: "auto 1fr auto", padding: "var(--s-3) var(--s-3)" }}
                onContextMenu={(e) => {
                  e.preventDefault();
                  setUserMenu({
                    x: e.clientX,
                    y: e.clientY,
                    user: { id: f.user.id, handle: f.user.handle ?? null, displayName: f.user.displayName },
                  });
                }}
              >
                <div style={{ position: "relative" }}>
                  <Avatar
                    src={f.user.avatarUrl ?? null}
                    fallbackInitials={f.user.displayName}
                    fallbackColorSeed={f.user.id}
                    size={36}
                  />
                  <span
                    style={{
                      position: "absolute",
                      bottom: -1,
                      right: -1,
                      display: "inline-flex",
                      borderRadius: "50%",
                      boxShadow: "0 0 0 2px var(--bg)",
                    }}
                  >
                    <PresenceDot state={presenceState} size={10} />
                  </span>
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
                  <span style={{ fontSize: "var(--t-sm)", display: "flex", gap: 6, alignItems: "baseline" }}>
                    <span style={{ fontWeight: 500, color: "var(--text)" }}>{f.user.displayName}</span>
                    {f.user.handle && (
                      <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                        @{f.user.handle}
                      </span>
                    )}
                  </span>
                  <span style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
                    {presenceState === "dnd" ? (
                      "Do Not Disturb"
                    ) : f.user.currentRoom ? (
                      <>
                        in <span style={{ color: "var(--text)", fontWeight: 500 }}>{f.user.currentRoom.name}</span>
                      </>
                    ) : presenceState === "online" ? (
                      "online"
                    ) : (
                      formatLastSeen(f.lastSeenAt)
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
                    onClick={() => onOpenDms?.(f.user.id)}
                  >
                    <I.Chat size={13} />
                  </button>
                  <button
                    className="rv-btn rv-btn-icon"
                    data-variant="ghost"
                    title="More"
                    style={{ height: "1.8rem", width: "1.8rem" }}
                    onClick={(e) => {
                      const r = e.currentTarget.getBoundingClientRect();
                      setUserMenu({
                        x: r.right - 230,
                        y: r.bottom + 4,
                        user: { id: f.user.id, handle: f.user.handle ?? null, displayName: f.user.displayName },
                      });
                    }}
                  >
                    ⋮
                  </button>
                </div>
              </div>
              );
            })
          )}

          {accepted.length > 0 && (
            <div style={{ textAlign: "center", padding: "var(--s-4) 0 var(--s-2)" }}>
              <span className="rv-label" style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
                · end of list ·
              </span>
            </div>
          )}

          {outgoing.length > 0 && (
            <div ref={outgoingRef} style={{ marginTop: "var(--s-5)" }}>
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

      {/* 2.2 PTT hint strip */}
      <div className="rv-ptt-hint">
        <span style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
          <span>Push-to-talk binds{openSettingsKeybind ? " in" : " live in"}</span>
          {openSettingsKeybind &&
            openSettingsKeybind.split("+").map((k) => (
              <kbd key={k} className="rv-kbd">
                {k}
              </kbd>
            ))}
          <span>{openSettingsKeybind ? "→ " : ""}Settings → Keybinds.</span>
        </span>
      </div>

      {/* Per-row ⋮ menu: DM · copy handle · remove (two-click confirm) */}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => {
            setRowMenu(null);
            setRemoveArmed(false);
          }}
          header={
            <>
              <Avatar
                src={rowMenu.friend.user.avatarUrl ?? null}
                fallbackInitials={rowMenu.friend.user.displayName}
                fallbackColorSeed={rowMenu.friend.user.id}
                size={26}
              />
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: "var(--t-xs)", fontWeight: 600 }}>{rowMenu.friend.user.displayName}</span>
                {rowMenu.friend.user.handle && (
                  <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                    @{rowMenu.friend.user.handle}
                  </span>
                )}
              </div>
            </>
          }
        >
          <MenuItem
            icon="✉"
            label="Send DM"
            onClick={() => {
              const id = rowMenu.friend.user.id;
              setRowMenu(null);
              onOpenDms?.(id);
            }}
          />
          <MenuItem
            icon="＠"
            label="Copy handle"
            disabled={!rowMenu.friend.user.handle}
            disabledHint="No handle set."
            onClick={() => {
              const h = rowMenu.friend.user.handle;
              setRowMenu(null);
              if (h) void navigator.clipboard.writeText(`@${h}`).catch(() => {});
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="✕"
            label={removeArmed ? "Really remove? Click again" : "Remove friend"}
            tone="danger"
            onClick={() => {
              if (!removeArmed) {
                setRemoveArmed(true);
                return;
              }
              const id = rowMenu.friend.friendshipId;
              setRowMenu(null);
              setRemoveArmed(false);
              void reject(id);
            }}
          />
        </ContextMenu>
      )}

      {/* Manage invite links (2.3 as a modal until it earns a page) */}
      <Modal
        open={invitesOpen}
        onClose={() => setInvitesOpen(false)}
        icon={<I.Link size={16} />}
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

      {/* 2.4d full user menu */}
      {userMenu && me && (
        <UserContextMenu
          x={userMenu.x}
          y={userMenu.y}
          user={userMenu.user}
          meId={me.id}
          onClose={() => setUserMenu(null)}
          onViewProfile={() => setProfilePeer(userMenu.user)}
          onSendDm={() => onOpenDms?.(userMenu.user.id)}
          onChanged={() => void refresh()}
        />
      )}

      {/* 2.4a peer profile popover */}
      {profilePeer && (
        <PeerProfilePopover
          peer={profilePeer}
          onClose={() => setProfilePeer(null)}
          {...(onJoinRoom ? { onJoinRoom } : {})}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}
