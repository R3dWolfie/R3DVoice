import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type FormEvent, type ReactElement } from "react";
import type { RoomDTO } from "@r3dvoice/shared";
import { ApiClient } from "../lib/api.js";
import { createRoomsStore, extractInviteCode, type RoomsState } from "../lib/rooms-store.js";
import { useAuthStore } from "../lib/auth-context.js";
import { getTransport } from "../lib/chat-transport.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import { pushToast } from "../lib/toast-store.js";
import { I } from "../components/Icons.js";
import { ContextMenu, MenuItem, MenuDivider, MenuSection } from "../components/ContextMenu.js";
import { CreateRoomModal } from "../components/CreateRoomModal.js";
import { InviteCreateModal } from "../components/InviteCreateModal.js";
import { RoomSettingsModal } from "../components/RoomSettingsModal.js";
import { PublicRoomsModal } from "../components/PublicRoomsModal.js";
import { InRoomScreen } from "./InRoomScreen.js";
import { buildJoinSelection, type JoinSelection } from "../lib/join-selection.js";
import { InvitePreviewScreen } from "./InvitePreviewScreen.js";

function useRoomsStore<T>(store: ReturnType<typeof createRoomsStore>, selector: (s: RoomsState) => T): T {
  return useSyncExternalStore(store.subscribe, () => selector(store.getState()), () => selector(store.getState()));
}

type Phase =
  | { kind: "lobby" }
  | { kind: "invite"; code: string }
  | { kind: "inroom"; roomId: string; selection: JoinSelection };

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
}

export function LobbyScreen({ pendingInviteCode, pendingJoinRoomId, onInviteCodeConsumed, onJoinRoomIdConsumed, onInviteCode, onOpenDms }: LobbyScreenProps = {}): ReactElement {
  const token = useAuthStore((s) => s.token);
  const serverUrl = useAuthStore((s) => s.serverUrl);

  const store = useMemo(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return createRoomsStore(api);
  }, [serverUrl, token]);

  const owned = useRoomsStore(store, (s) => s.owned);
  const recent = useRoomsStore(store, (s) => s.recent);
  const status = useRoomsStore(store, (s) => s.status);
  const error = useRoomsStore(store, (s) => s.error);
  const activeRoomId = useRoomsStore(store, (s) => s.activeRoomId);

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
  const addMenuRef = useRef<HTMLDivElement>(null);
  const favoriteRoomIds = usePrefs((s) => s.favoriteRoomIds);
  useEffect(() => {
    void store.getState().refresh();
  }, [store]);

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

  // Deck rule: no pre-join screen (4.5 removed) — joins go straight in,
  // muted, with the persisted device/quality prefs.
  const joinMicDeviceId = usePrefs((s) => s.micDeviceId);
  const joinSpeakerDeviceId = usePrefs((s) => s.speakerDeviceId);
  const joinResolution = usePrefs((s) => s.resolution);
  const joinFrameRate = usePrefs((s) => s.frameRate);
  useEffect(() => {
    if (activeRoomId && phase.kind === "lobby") {
      setPhase({
        kind: "inroom",
        roomId: activeRoomId,
        selection: buildJoinSelection({
          micDeviceId: joinMicDeviceId,
          speakerDeviceId: joinSpeakerDeviceId,
          resolution: joinResolution,
          frameRate: joinFrameRate,
        }),
      });
    }
  }, [activeRoomId, phase.kind, joinMicDeviceId, joinSpeakerDeviceId, joinResolution, joinFrameRate]);

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
        timer = setTimeout(() => void store.getState().refresh(), 800);
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [store]);

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
    if (!joinInput.trim()) return;
    const inviteCode = extractInviteCode(joinInput);
    if (inviteCode) {
      if (onInviteCode) {
        onInviteCode(inviteCode);
      } else {
        setPhase({ kind: "invite", code: inviteCode });
      }
      return;
    }
    await store.getState().join(joinInput.trim());
  }

  if (phase.kind === "invite") {
    return (
      <InvitePreviewScreen
        code={phase.code}
        onRedirect={(redirectTo) => {
          onInviteCodeConsumed?.();
          if (redirectTo.startsWith("/rooms/")) {
            const roomId = redirectTo.replace(/^\/rooms\//, "");
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

  if (phase.kind === "inroom") {
    return (
      <InRoomScreen
        roomId={phase.roomId}
        selection={phase.selection}
        onLeave={() => {
          store.getState().clearActive();
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
  const starred = [...allRooms.values()].filter((r) => favoriteRoomIds.includes(r.id)).filter(matches);
  const myRooms = owned.filter((r) => !favoriteRoomIds.includes(r.id)).filter(matches);

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

  const copyRoomLink = (roomId: string): void => {
    const url = `${serverUrl.replace(/\/$/, "")}/join/${roomId}`;
    void navigator.clipboard
      .writeText(url)
      .then(() => pushToast({ kind: "success", text: "Room link copied", sub: url }))
      .catch(() => pushToast({ kind: "error", text: "Couldn't access the clipboard" }));
  };

  const roomRow = (r: RoomDTO, starredRow: boolean): ReactElement => (
    <div
      key={r.id}
      className="rv-list-item"
      onClick={() => void store.getState().join(r.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        setCtxMenu({ x: e.clientX, y: e.clientY, room: r });
      }}
    >
      <RoomAvatar name={r.name} />
      <div style={{ display: "flex", flexDirection: "column", gap: 1, minWidth: 0, flex: 1 }}>
        <span style={{ fontSize: "var(--t-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
          {r.name}
        </span>
        <span
          className="rv-mono"
          style={{ fontSize: "var(--t-2xs)", color: (r.inCall ?? 0) > 0 ? "var(--ok)" : "var(--text-faint)" }}
          title={`${r.isOwner ? "yours" : "member"} · ${relativeAge(r.lastJoined ?? r.createdAt)}`}
        >
          {(r.inCall ?? 0) > 0 ? `${r.inCall} in call` : "empty"}
        </span>
      </div>
      {(r.inCall ?? 0) > 0 && (
        <span style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
      )}
      {starredRow && <I.StarFilled size={12} style={{ color: "var(--rv-amber)", flexShrink: 0 }} />}
    </div>
  );

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
          <form
            onSubmit={(e) => {
              void onJoin(e);
              setJoinOpen(false);
              setJoinInput("");
            }}
            style={{ display: "flex", gap: "var(--s-2)", padding: "var(--s-3) var(--s-3) 0" }}
          >
            <input
              autoFocus
              className="rv-input"
              placeholder="Invite link, room link, or ID"
              value={joinInput}
              onChange={(e) => setJoinInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") setJoinOpen(false);
              }}
              style={{ height: "2rem", fontSize: "var(--t-xs)" }}
            />
            <button
              className="rv-btn"
              data-variant="primary"
              type="submit"
              disabled={!joinInput.trim()}
              style={{ height: "2rem", padding: "0 var(--s-3)", fontSize: "var(--t-xs)" }}
            >
              Go
            </button>
          </form>
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
                  <div className="rv-empty" style={{ padding: "var(--s-6) var(--s-3)" }}>
                    <span className="rv-empty-title">No rooms yet</span>
                    <span className="rv-empty-hint">Hit + to create one or paste an invite.</span>
                  </div>
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
          <div
            style={{
              padding: "var(--s-2) var(--s-8) var(--s-2)",
              display: "flex",
              alignItems: "baseline",
              gap: "var(--s-3)",
            }}
          >
            <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>Activity</span>
            <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
              recent
            </span>
          </div>

          {error && (
            <div style={{ padding: "0 var(--s-8) var(--s-3)" }}>
              <div className="rv-err-banner" role="alert">
                <span className="ic">!</span>
                <div>{error}</div>
              </div>
            </div>
          )}

          {feed.length === 0 ? (
            <div className="rv-empty" style={{ paddingTop: "var(--s-10)" }}>
              <span className="rv-empty-title">Nothing here yet</span>
              <span className="rv-empty-hint">Create a room or join one — your activity shows up here.</span>
            </div>
          ) : (
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
                      onClick={() => void store.getState().join(f.room.id)}
                      style={{ height: "1.9rem", padding: "0 var(--s-4)", fontSize: "var(--t-xs)" }}
                    >
                      Join ›
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
              setCtxMenu(null);
              void store.getState().join(ctxMenu.room.id);
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
