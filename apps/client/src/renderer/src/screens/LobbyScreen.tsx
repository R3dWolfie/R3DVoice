import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent, type ReactElement } from "react";
import type { FriendDTO, RoomDTO } from "@r3dvoice/shared";
import { ApiClient } from "../lib/api.js";
import { extractInviteCode } from "../lib/rooms-store.js";
import { getRoomsStore, useRoomsStore } from "../lib/rooms-singleton.js";
import { useAuthStore } from "../lib/auth-context.js";
import { getTransport } from "../lib/chat-transport.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import { pushToast } from "../lib/toast-store.js";
import { I } from "../components/Icons.js";
import { UnreadDot } from "../components/UnreadDot.js";
import { useUnreadStore } from "../lib/unread-store.js";
import { ContextMenu, MenuItem, MenuDivider, MenuSection } from "../components/ContextMenu.js";
import { CreateRoomModal } from "../components/CreateRoomModal.js";
import { InviteCreateModal } from "../components/InviteCreateModal.js";
import { RoomSettingsModal } from "../components/RoomSettingsModal.js";
import { PublicRoomsModal } from "../components/PublicRoomsModal.js";
import { InvitePreviewScreen } from "./InvitePreviewScreen.js";
import { LiveActivityRow, type LiveRoom } from "../components/LiveActivityRow.js";

// The in-room screen and its live LiveKit connection live at the app shell
// (App.tsx) now, driven by the shared rooms store's activeRoomId, so a call
// survives navigation. The lobby only owns lobby/invite phases.
type Phase =
  | { kind: "lobby" }
  | { kind: "invite"; code: string };

function initialsFromName(name: string): string {
  return name.split(" ").map((s) => s[0] ?? "").slice(0, 2).join("").toUpperCase() || "?";
}

function relativeAge(iso: string | null): string {
  if (!iso) return "new";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Square mono-initials plate per the deck's sidebar .avatar.
function RoomAvatar({ name, size = 28 }: { name: string; size?: number }): ReactElement {
  return (
    <span
      aria-hidden
      style={{
        width: size,
        height: size,
        flexShrink: 0,
        borderRadius: "var(--r-md)",
        background: "var(--bg-elev-2)",
        border: "1px solid var(--border)",
        display: "grid",
        placeItems: "center",
        fontFamily: "var(--font-mono)",
        fontSize: Math.round(size * 0.36),
        fontWeight: 700,
        color: "var(--text-mid)",
      }}
    >
      {initialsFromName(name)}
    </span>
  );
}

interface LobbyScreenProps {
  pendingInviteCode?: string | null;
  pendingJoinRoomId?: string | null;
  onInviteCodeConsumed?: () => void;
  onJoinRoomIdConsumed?: () => void;
  onInviteCode?: (code: string) => void;
  /** Friend invites redeem into the DMs page — App switches the rail page. */
  onOpenDms?: () => void;
  /** Clicking the room you're already in (call running minimized) returns to it. */
  onReturnToCall?: () => void;
}

export function LobbyScreen({ pendingInviteCode, pendingJoinRoomId, onInviteCodeConsumed, onJoinRoomIdConsumed, onInviteCode, onOpenDms, onReturnToCall }: LobbyScreenProps = {}): ReactElement {
  const token = useAuthStore((s) => s.token);
  const serverUrl = useAuthStore((s) => s.serverUrl);

  // Shared module-level store (survives navigation). App.tsx renders the
  // in-room screen from the same instance's activeRoomId.
  const store = getRoomsStore(serverUrl, token);

  const owned = useRoomsStore(store, (s) => s.owned);
  const recent = useRoomsStore(store, (s) => s.recent);
  const status = useRoomsStore(store, (s) => s.status);
  const error = useRoomsStore(store, (s) => s.error);

  const [phase, setPhase] = useState<Phase>({ kind: "lobby" });
  const [filter, setFilter] = useState("");
  const [addMenuOpen, setAddMenuOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [createBusy, setCreateBusy] = useState(false);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; room: RoomDTO } | null>(null);
  const [inviteFor, setInviteFor] = useState<string | null>(null);
  const [settingsFor, setSettingsFor] = useState<RoomDTO | null>(null);
  const [browseOpen, setBrowseOpen] = useState(false);
  // Per-row join in-flight + inline failure (mirrors the createBusy pattern).
  const [joiningId, setJoiningId] = useState<string | null>(null);
  const [rowJoinError, setRowJoinError] = useState<{ id: string; message: string } | null>(null);
  // Join-by-link ("Go") in-flight + inline failure.
  const [joinByLinkBusy, setJoinByLinkBusy] = useState(false);
  const [joinByLinkError, setJoinByLinkError] = useState<string | null>(null);
  const addMenuRef = useRef<HTMLDivElement>(null);
  const favoriteRoomIds = usePrefs((s) => s.favoriteRoomIds);
  // Unread/mention badges on room rows — the store is keyed room:<id>.
  const unreadCounts = useUnreadStore((s) => s.counts);

  // Friends power the "live · people talking now" feed highlight (2.1): a
  // friend's presence carries `currentRoom`, so we can surface rooms where
  // friends are talking right now. Refetched on presence.update below.
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const loadFriends = useCallback((): void => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    void api
      .friends()
      .then((r) => setFriends(r.friends.filter((f) => f.status === "accepted")))
      .catch(() => {});
  }, [serverUrl, token]);
  useEffect(() => {
    loadFriends();
  }, [loadFriends]);

  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

  // Refresh unread counts so room rows show badges without opening a DM first.
  useEffect(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    void useUnreadStore.getState().refresh(api);
  }, [serverUrl, token]);

  // A user-initiated join with a per-row busy state + inline error. The store's
  // join() swallows failures into store.error and flips activeRoomId on
  // success, so we read both back after it settles.
  async function attemptJoin(roomId: string): Promise<void> {
    // Already in this call (running minimized in the shell) — clicking it should
    // return to the call view, not re-join (which is a no-op and looks dead).
    if (roomId === store.getState().activeRoomId) {
      onReturnToCall?.();
      return;
    }
    if (joiningId) return;
    setJoiningId(roomId);
    setRowJoinError(null);
    try {
      await store.getState().join(roomId);
      const st = store.getState();
      if (!st.activeRoomId && st.error) {
        setRowJoinError({ id: roomId, message: st.error });
      }
    } finally {
      setJoiningId(null);
    }
  }

  useEffect(() => {
    if (pendingJoinRoomId) {
      void store.getState().join(pendingJoinRoomId);
      onJoinRoomIdConsumed?.();
    }
  }, [pendingJoinRoomId, store, onJoinRoomIdConsumed]);

  // Transition to invite phase when a pending invite code arrives from App.tsx.
  useEffect(() => {
    if (pendingInviteCode && phase.kind === "lobby") {
      setPhase({ kind: "invite", code: pendingInviteCode });
    }
  }, [pendingInviteCode, phase.kind]);

  // Deck rule: no pre-join screen (4.5 removed) — joins go straight in, muted,
  // with the persisted device/quality prefs. store.join() flips activeRoomId;
  // App.tsx watches it, freezes the join selection, and mounts the in-room
  // screen at shell level so the call outlives navigation.

  // Membership and ownership change while a room screen is up (join, delete,
  // transfer) — refetch the sidebar on every phase flip so deleted rooms
  // don't linger with phantom occupancy (live QA finding).
  useEffect(() => {
    void store.getState().refresh();
  }, [phase.kind, store]);

  // Deep-link consumer: r3dvoice://join/<uuid> → auto-open the prejoin flow.
  // Preload replays any queued event on subscribe, so cold-start with a
  // restored session also works.
  useEffect(() => {
    return window.r3dvoice.onDeepLink((link) => {
      if (link.type === "join-room") {
        void store.getState().join(link.roomId);
      }
    });
  }, [store]);

  const [joinInput, setJoinInput] = useState("");

  // Periodic health probe — drives the "connected" badge in the top bar.
  // Validates response body so ISP NXDOMAIN redirects don't show green.
  const [online, setOnline] = useState<"checking" | "ok" | "down">("checking");
  useEffect(() => {
    let cancelled = false;
    const probe = async (): Promise<void> => {
      try {
        const res = await fetch(`${serverUrl.replace(/\/$/, "")}/health`);
        if (cancelled) return;
        if (!res.ok) return setOnline("down");
        const ct = res.headers.get("content-type") ?? "";
        if (!ct.includes("application/json")) return setOnline("down");
        const body = (await res.json()) as { status?: string };
        if (!cancelled) setOnline(body.status === "ok" ? "ok" : "down");
      } catch {
        if (!cancelled) setOnline("down");
      }
    };
    void probe();
    const interval = setInterval(() => void probe(), 15000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [serverUrl]);

  // Live occupancy: refresh room lists when anyone's presence changes.
  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = t.on((event) => {
      if (event.type === "presence.update") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => {
          void store.getState().refresh();
          loadFriends();
        }, 800);
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [store, loadFriends]);

  // Close the + menu on outside click.
  useEffect(() => {
    if (!addMenuOpen) return;
    function onDown(e: MouseEvent): void {
      if (addMenuRef.current && !addMenuRef.current.contains(e.target as Node)) setAddMenuOpen(false);
    }
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [addMenuOpen]);

  async function onJoin(e: FormEvent): Promise<void> {
    e.preventDefault();
    const raw = joinInput.trim();
    if (!raw) return;
    const inviteCode = extractInviteCode(raw);
    if (inviteCode) {
      if (onInviteCode) {
        onInviteCode(inviteCode);
      } else {
        setPhase({ kind: "invite", code: inviteCode });
      }
      setJoinOpen(false);
      setJoinInput("");
      return;
    }
    setJoinByLinkBusy(true);
    setJoinByLinkError(null);
    try {
      await store.getState().join(raw);
      const st = store.getState();
      if (!st.activeRoomId && st.error) {
        // Surface the failure inline instead of silently closing the field.
        setJoinByLinkError(st.error);
        return;
      }
      setJoinOpen(false);
      setJoinInput("");
    } finally {
      setJoinByLinkBusy(false);
    }
  }

  if (phase.kind === "invite") {
    return (
      <InvitePreviewScreen
        code={phase.code}
        onRedirect={(redirectTo) => {
          onInviteCodeConsumed?.();
          if (redirectTo.startsWith("/rooms/")) {
            const roomId = redirectTo.replace(/^\/rooms\//, "");
            // Return to the lobby so the phase-gated join transition fires;
            // without this the invite card stays mounted and never enters.
            setPhase({ kind: "lobby" });
            void store.getState().join(roomId);
          } else if (redirectTo.startsWith("/dms") && onOpenDms) {
            setPhase({ kind: "lobby" });
            onOpenDms();
          } else {
            setPhase({ kind: "lobby" });
          }
        }}
        onCancel={() => {
          onInviteCodeConsumed?.();
          setPhase({ kind: "lobby" });
        }}
      />
    );
  }

  // Sidebar sections per 2.1: Starred (prefs) then My rooms; recent rooms
  // surface in the activity feed instead of a third sidebar section.
  const allRooms = new Map<string, RoomDTO>();
  for (const r of [...owned, ...recent]) allRooms.set(r.id, r);
  const matches = (r: RoomDTO): boolean => r.name.toLowerCase().includes(filter.trim().toLowerCase());
  const starredUnfiltered = [...allRooms.values()].filter((r) => favoriteRoomIds.includes(r.id));
  const starred = starredUnfiltered.filter(matches);
  const myRooms = owned.filter((r) => !favoriteRoomIds.includes(r.id)).filter(matches);
  // Distinguish "you have no rooms" from "the filter matched nothing".
  const filterActive = filter.trim().length > 0;
  const hasAnyRooms = owned.length > 0 || starredUnfiltered.length > 0;

  type FeedEntry = { key: string; at: number; icon: string; title: ReactElement; meta: string; room: RoomDTO; action: "open" | "copy" };
  const feed: FeedEntry[] = [
    ...owned.map((r): FeedEntry => ({
      key: `created-${r.id}`,
      at: new Date(r.createdAt).getTime(),
      icon: "＋",
      title: (
        <span>
          You created <b style={{ fontWeight: 600 }}>{r.name}</b>
        </span>
      ),
      meta: r.isPublic ? "public room" : "unlisted · link-only",
      room: r,
      action: "copy",
    })),
    ...recent.map((r): FeedEntry => ({
      key: `recent-${r.id}`,
      at: r.lastJoined ? new Date(r.lastJoined).getTime() : 0,
      icon: "⏱",
      title: (
        <span>
          <b style={{ fontWeight: 600 }}>{r.name}</b> · last met {relativeAge(r.lastJoined)}
        </span>
      ),
      meta: r.isPublic ? "public room" : "unlisted",
      room: r,
      action: "open",
    })),
  ]
    .sort((a, b) => b.at - a.at)
    .slice(0, 25);

  // "Live now" highlight (2.1 centerpiece): rooms with people talking right
  // now, derived from friend presence (`currentRoom`) and our own rooms'
  // occupancy (`inCall`). Omitted entirely when nothing is live.
  const liveRooms: LiveRoom[] = (() => {
    const map = new Map<string, LiveRoom>();
    for (const f of friends) {
      const cr = f.user.currentRoom;
      if (!cr) continue;
      const existing = map.get(cr.id);
      if (existing) existing.friends.push(f);
      else map.set(cr.id, { roomId: cr.id, name: cr.name, friends: [f], inCall: 0 });
    }
    for (const r of [...owned, ...recent]) {
      const n = r.inCall ?? 0;
      if (n <= 0) continue;
      const existing = map.get(r.id);
      if (existing) existing.inCall = Math.max(existing.inCall, n);
      else map.set(r.id, { roomId: r.id, name: r.name, friends: [], inCall: n });
    }
    for (const lr of map.values()) lr.inCall = Math.max(lr.inCall, lr.friends.length);
    return [...map.values()].filter((lr) => lr.inCall > 0);
  })();

  const copyRoomLink = (roomId: string): void => {
    const url = `${serverUrl.replace(/\/$/, "")}/join/${roomId}`;
    void navigator.clipboard
      .writeText(url)
      .then(() => pushToast({ kind: "success", text: "Room link copied", sub: url }))
      .catch(() => pushToast({ kind: "error", text: "Couldn't access the clipboard" }));
  };

  const roomRow = (r: RoomDTO, starredRow: boolean): ReactElement => {
    const busy = joiningId === r.id;
    const unread = unreadCounts[`room:${r.id}`] ?? 0;
    const rowErr = rowJoinError?.id === r.id ? rowJoinError.message : null;
    return (
      <div key={r.id} style={{ display: "flex", flexDirection: "column" }}>
        <div
          className="rv-list-item"
          role="button"
          tabIndex={busy ? -1 : 0}
          aria-busy={busy}
          onClick={() => {
            if (busy) return;
            void attemptJoin(r.id);
          }}
          onKeyDown={(e) => {
            if (!busy && (e.key === "Enter" || e.key === " ")) {
              e.preventDefault();
              void attemptJoin(r.id);
            }
          }}
          onContextMenu={(e) => {
            e.preventDefault();
            setCtxMenu({ x: e.clientX, y: e.clientY, room: r });
          }}
          style={{ opacity: busy ? 0.6 : 1, cursor: busy ? "default" : "pointer" }}
        >
          <RoomAvatar name={r.name} />
          <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
            <span
              style={{
                fontSize: "var(--t-sm)",
                fontWeight: unread > 0 ? 600 : 400,
                whiteSpace: "nowrap",
                overflow: "hidden",
                textOverflow: "ellipsis",
              }}
            >
              {r.name}
            </span>
            <span
              className="rv-mono"
              style={{ fontSize: "var(--t-2xs)", color: (r.inCall ?? 0) > 0 ? "var(--ok)" : "var(--text-faint)" }}
              title={`${r.isOwner ? "yours" : "member"} · ${relativeAge(r.lastJoined ?? r.createdAt)}`}
            >
              {busy ? "joining…" : (r.inCall ?? 0) > 0 ? `${r.inCall} in call` : "empty"}
            </span>
          </div>
          {busy && <span className="rv-inline-spinner" style={{ flexShrink: 0 }} aria-hidden />}
          {!busy && unread > 0 && <UnreadDot count={unread} />}
          {!busy && (r.inCall ?? 0) > 0 && (
            <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
          )}
          {starredRow && <I.StarFilled size={12} style={{ color: "var(--rv-amber)", flexShrink: 0 }} />}
        </div>
        {rowErr && (
          <div
            role="alert"
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              margin: "2px var(--s-2) var(--s-1)",
              padding: "var(--s-1) var(--s-2)",
              fontSize: "var(--t-2xs)",
              color: "var(--danger)",
            }}
          >
            <span style={{ flex: 1 }}>{rowErr}</span>
            <button
              type="button"
              className="rv-btn"
              onClick={(e) => {
                e.stopPropagation();
                void attemptJoin(r.id);
              }}
              style={{ height: "1.5rem", padding: "0 var(--s-2)", fontSize: "var(--t-2xs)" }}
            >
              Retry
            </button>
          </div>
        )}
      </div>
    );
  };

  return (
    <div style={{ display: "grid", gridTemplateColumns: "280px 1fr", height: "100%", minHeight: 0 }}>
      {/* Rooms sidebar (2.1) */}
      <aside
        style={{
          borderRight: "1px solid var(--border-soft)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
          background: "var(--bg)",
        }}
      >
        <div
          style={{
            height: "3.5rem",
            padding: "0 var(--s-4)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
            flexShrink: 0,
          }}
        >
          <span style={{ fontSize: "var(--t-sm)", fontWeight: 600, flex: 1 }}>Rooms</span>
          <div ref={addMenuRef} style={{ position: "relative" }}>
            <button
              type="button"
              aria-label="Join · Create · Browse"
              title="Join · Create · Browse"
              onClick={() => setAddMenuOpen((v) => !v)}
              style={{
                width: "1.75rem",
                height: "1.75rem",
                border: 0,
                borderRadius: "var(--r-md)",
                background: "var(--accent)",
                color: "var(--on-accent)",
                fontSize: "var(--t-md)",
                fontWeight: 600,
                lineHeight: 1,
                display: "inline-flex",
                alignItems: "center",
                justifyContent: "center",
                cursor: "pointer",
              }}
            >
              +
            </button>
            {addMenuOpen && (
              <div
                className="rv-menu rv-fade-in"
                style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, width: 250, zIndex: 40 }}
              >
                <button
                  type="button"
                  className="rv-menu-item"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setCreateOpen(true);
                  }}
                >
                  <span style={{ width: 28, height: 28, borderRadius: "var(--r-md)", background: "var(--text)", color: "var(--bg)", display: "grid", placeItems: "center", fontWeight: 700, flexShrink: 0 }}>+</span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                    <span style={{ fontWeight: 600 }}>Create new room</span>
                    <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>Set name, privacy, description.</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="rv-menu-item"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setJoinOpen(true);
                  }}
                >
                  <span style={{ width: 28, height: 28, borderRadius: "var(--r-md)", background: "var(--bg-elev-2)", border: "1px solid var(--border)", color: "var(--text-mid)", display: "grid", placeItems: "center", fontWeight: 700, flexShrink: 0 }}>↗</span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                    <span style={{ fontWeight: 600 }}>Join by link or ID</span>
                    <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>Paste an invite link.</span>
                  </span>
                </button>
                <button
                  type="button"
                  className="rv-menu-item"
                  onClick={() => {
                    setAddMenuOpen(false);
                    setBrowseOpen(true);
                  }}
                >
                  <span style={{ width: 28, height: 28, borderRadius: "var(--r-md)", background: "var(--bg-elev-2)", border: "1px solid var(--border)", color: "var(--text-mid)", display: "grid", placeItems: "center", fontWeight: 700, flexShrink: 0 }}>◎</span>
                  <span style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
                    <span style={{ fontWeight: 600 }}>Browse public rooms</span>
                    <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>Find rooms with people in them.</span>
                  </span>
                </button>
              </div>
            )}
          </div>
        </div>

        {joinOpen && (
          <div style={{ padding: "var(--s-3) var(--s-3) 0" }}>
            <form
              onSubmit={(e) => void onJoin(e)}
              style={{ display: "flex", gap: "var(--s-2)" }}
            >
              <input
                autoFocus
                className="rv-input"
                placeholder="Invite link, room link, or ID"
                value={joinInput}
                onChange={(e) => {
                  setJoinInput(e.target.value);
                  if (joinByLinkError) setJoinByLinkError(null);
                }}
                onKeyDown={(e) => {
                  if (e.key === "Escape") setJoinOpen(false);
                }}
                disabled={joinByLinkBusy}
                style={{ height: "2rem", fontSize: "var(--t-xs)" }}
              />
              <button
                className="rv-btn"
                data-variant="primary"
                type="submit"
                disabled={!joinInput.trim() || joinByLinkBusy}
                style={{ height: "2rem", padding: "0 var(--s-3)", fontSize: "var(--t-xs)" }}
              >
                {joinByLinkBusy ? <span className="rv-inline-spinner" aria-label="Joining" /> : "Go"}
              </button>
            </form>
            {joinByLinkError && (
              <div className="rv-err-banner" role="alert" style={{ marginTop: "var(--s-2)", padding: "var(--s-2) var(--s-3)", fontSize: "var(--t-xs)" }}>
                <span className="ic">!</span>
                <div>{joinByLinkError}</div>
              </div>
            )}
          </div>
        )}

        <div
          style={{
            margin: "var(--s-3) var(--s-3) var(--s-1)",
            display: "flex",
            alignItems: "center",
            gap: "var(--s-2)",
          }}
        >
          <input
            className="rv-input"
            placeholder="Filter rooms…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ height: "2rem", fontSize: "var(--t-xs)" }}
          />
        </div>

        <div className="rv-scroll" style={{ flex: 1, overflow: "auto", padding: "var(--s-2) var(--s-2) var(--s-1)" }}>
          {status === "loading" && owned.length === 0 && recent.length === 0 ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", padding: "var(--s-2)" }}>
              <div className="rv-skeleton" style={{ height: "2.5rem" }} />
              <div className="rv-skeleton" style={{ height: "2.5rem" }} />
              <div className="rv-skeleton" style={{ height: "2.5rem" }} />
            </div>
          ) : (
            <>
              {starred.length > 0 && (
                <div style={{ marginBottom: "var(--s-4)" }}>
                  <div className="rv-label" style={{ padding: "var(--s-1) var(--s-2)", fontSize: "var(--t-2xs)" }}>
                    ★ Starred · {starred.length}
                  </div>
                  <div className="rv-list">{starred.map((r) => roomRow(r, true))}</div>
                </div>
              )}
              <div>
                <div className="rv-label" style={{ padding: "var(--s-1) var(--s-2)", fontSize: "var(--t-2xs)" }}>
                  My rooms · {myRooms.length}
                </div>
                {myRooms.length === 0 && starred.length === 0 ? (
                  filterActive && hasAnyRooms ? (
                    <div className="rv-empty" style={{ padding: "var(--s-6) var(--s-3)" }}>
                      <span className="rv-empty-title">No rooms match “{filter.trim()}”</span>
                      <span className="rv-empty-hint">Clear the filter to see all your rooms.</span>
                    </div>
                  ) : (
                    <div className="rv-empty" style={{ padding: "var(--s-6) var(--s-3)" }}>
                      <span className="rv-empty-title">No rooms yet</span>
                      <span className="rv-empty-hint">Hit + to create one or paste an invite.</span>
                    </div>
                  )
                ) : (
                  <div className="rv-list">{myRooms.map((r) => roomRow(r, false))}</div>
                )}
              </div>
            </>
          )}
        </div>
      </aside>

      {/* Activity feed (2.1 main panel) */}
      <main style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
        {online === "down" && (
          <div className="rv-banner" data-tone="error">
            Can't reach the server — retrying…
          </div>
        )}
        {online !== "down" && <div />}

        <div className="rv-scroll" style={{ overflow: "auto", paddingTop: "var(--s-4)" }}>
          {liveRooms.length > 0 && (
            <>
              <div
                style={{
                  padding: "var(--s-2) var(--s-8) var(--s-2)",
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                }}
              >
                <span
                  aria-hidden
                  style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }}
                />
                <span className="rv-label" style={{ fontSize: "var(--t-2xs)", color: "var(--ok)" }}>
                  Live now
                </span>
                <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
                  people talking now · {liveRooms.length}
                </span>
              </div>
              {liveRooms.map((lr) => (
                <LiveActivityRow
                  key={`live-${lr.roomId}`}
                  room={lr}
                  joining={joiningId === lr.roomId}
                  onJoin={() => void attemptJoin(lr.roomId)}
                />
              ))}
            </>
          )}

          {feed.length > 0 && (
            <div
              style={{
                padding: "var(--s-2) var(--s-8) var(--s-2)",
                display: "flex",
                alignItems: "baseline",
                gap: "var(--s-3)",
                borderTop: liveRooms.length > 0 ? "1px solid var(--border-soft)" : "none",
                marginTop: liveRooms.length > 0 ? "var(--s-3)" : 0,
              }}
            >
              <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>Activity</span>
              <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
                recent
              </span>
            </div>
          )}

          {error && (
            <div style={{ padding: "0 var(--s-8) var(--s-3)" }}>
              <div className="rv-err-banner" role="alert">
                <span className="ic">!</span>
                <div>{error}</div>
              </div>
            </div>
          )}

          {feed.length === 0 && liveRooms.length === 0 ? (
            <div className="rv-empty" style={{ paddingTop: "var(--s-10)" }}>
              <span className="rv-empty-title">Nothing here yet</span>
              <span className="rv-empty-hint">Create a room or join one — your activity shows up here.</span>
            </div>
          ) : feed.length === 0 ? null : (
            feed.map((f, i) => (
              <div
                key={f.key}
                style={{
                  padding: "var(--s-3) var(--s-8)",
                  display: "grid",
                  gridTemplateColumns: "2.25rem 1fr auto",
                  gap: "var(--s-4)",
                  alignItems: "center",
                  borderTop: i === 0 ? "none" : "1px solid var(--border-soft)",
                }}
              >
                <div
                  aria-hidden
                  style={{
                    width: "2.25rem",
                    height: "2.25rem",
                    borderRadius: "var(--r-md)",
                    background: "var(--bg-elev-2)",
                    border: "1px solid var(--border)",
                    display: "grid",
                    placeItems: "center",
                    color: "var(--text-dim)",
                    fontFamily: "var(--font-mono)",
                  }}
                >
                  {f.icon}
                </div>
                <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                  <span style={{ fontSize: "var(--t-sm)", lineHeight: 1.4 }}>{f.title}</span>
                  <span
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--s-3)",
                      fontSize: "var(--t-xs)",
                      color: "var(--text-dim)",
                    }}
                  >
                    <span>{f.meta}</span>
                    <span className="rv-mono" style={{ marginLeft: "auto", fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
                      {relativeAge(new Date(f.at).toISOString())}
                    </span>
                  </span>
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)" }}>
                  {f.action === "open" ? (
                    <button
                      className="rv-btn"
                      data-variant="primary"
                      disabled={joiningId === f.room.id}
                      onClick={() => void attemptJoin(f.room.id)}
                      style={{ height: "1.9rem", padding: "0 var(--s-4)", fontSize: "var(--t-xs)" }}
                    >
                      {joiningId === f.room.id ? <span className="rv-inline-spinner" aria-label="Joining" /> : "Join ›"}
                    </button>
                  ) : (
                    <button
                      className="rv-btn"
                      onClick={() => copyRoomLink(f.room.id)}
                      style={{ height: "1.9rem", padding: "0 var(--s-4)", fontSize: "var(--t-xs)" }}
                    >
                      Copy link
                    </button>
                  )}
                </div>
              </div>
            ))
          )}

          {feed.length > 0 && (
            <div
              style={{
                padding: "var(--s-5) var(--s-8)",
                display: "flex",
                justifyContent: "center",
                borderTop: "1px solid var(--border-soft)",
              }}
            >
              <span className="rv-label" style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
                · end of recent activity ·
              </span>
            </div>
          )}
        </div>
      </main>

      {/* Room right-click menu (2.1b) */}
      {ctxMenu && (
        <ContextMenu
          x={ctxMenu.x}
          y={ctxMenu.y}
          onClose={() => setCtxMenu(null)}
          header={
            <>
              <RoomAvatar name={ctxMenu.room.name} size={26} />
              <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                <span style={{ fontSize: "var(--t-xs)", fontWeight: 600 }}>{ctxMenu.room.name}</span>
                <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                  {ctxMenu.room.isPublic ? "public" : "unlisted"} · {ctxMenu.room.isOwner ? "yours" : "member"}
                </span>
              </div>
            </>
          }
        >
          <MenuItem
            icon="⌂"
            label="Open"
            kbd="↵"
            onClick={() => {
              const id = ctxMenu.room.id;
              setCtxMenu(null);
              void attemptJoin(id);
            }}
          />
          <MenuItem
            icon="★"
            label={favoriteRoomIds.includes(ctxMenu.room.id) ? "Unstar" : "Star"}
            onClick={() => {
              prefsActions().toggleFavoriteRoom(ctxMenu.room.id);
              setCtxMenu(null);
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="＋"
            label="Invite to room…"
            onClick={() => {
              setInviteFor(ctxMenu.room.id);
              setCtxMenu(null);
            }}
          />
          <MenuItem
            icon="🔗"
            label="Copy room link"
            onClick={() => {
              copyRoomLink(ctxMenu.room.id);
              setCtxMenu(null);
            }}
          />
          <MenuDivider />
          <MenuSection label="Notifications" />
          <MenuItem icon="🔕" label="Mute" disabled disabledHint="Coming with the notifications pass." />
          <MenuDivider />
          <MenuItem
            icon="⚙"
            label="Room Settings"
            onClick={() => {
              setSettingsFor(ctxMenu.room);
              setCtxMenu(null);
            }}
          />
          <MenuDivider />
          {ctxMenu.room.isOwner ? (
            <MenuItem
              icon="✕"
              label="Leave room"
              tone="danger"
              disabled
              disabledHint="Owners can't leave — transfer or delete from Room Settings."
            />
          ) : (
            <MenuItem
              icon="✕"
              label="Leave room"
              tone="danger"
              onClick={() => {
                const id = ctxMenu.room.id;
                setCtxMenu(null);
                const api = new ApiClient(serverUrl);
                api.setToken(token);
                void api.leaveRoom(id).then(() => store.getState().refresh());
              }}
            />
          )}
        </ContextMenu>
      )}

      {settingsFor && (
        <RoomSettingsModal
          room={settingsFor}
          onClose={() => setSettingsFor(null)}
          onChanged={() => void store.getState().refresh()}
          onGone={() => {
            setSettingsFor(null);
            void store.getState().refresh();
          }}
        />
      )}

      <CreateRoomModal
        open={createOpen}
        busy={createBusy}
        onClose={() => setCreateOpen(false)}
        onCreate={(name, isPublic, description) => {
          setCreateBusy(true);
          void store
            .getState()
            .create(name, isPublic, description)
            .then(() => setCreateOpen(false))
            .finally(() => setCreateBusy(false));
        }}
      />

      {inviteFor && (
        <InviteCreateModal open={true} roomId={inviteFor} onClose={() => setInviteFor(null)} />
      )}

      {browseOpen && (
        <PublicRoomsModal
          onClose={() => setBrowseOpen(false)}
          onJoin={(roomId) => void store.getState().join(roomId)}
        />
      )}
    </div>
  );
}
