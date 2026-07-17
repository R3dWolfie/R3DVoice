import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { DmThreadEntry } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { Avatar } from "../components/Avatar.js";
import { ContextMenu, MenuItem, MenuDivider } from "../components/ContextMenu.js";
import { DmThreadList } from "../components/DmThreadList.js";
import { FriendsPane } from "../components/FriendsPane.js";
import { NewDmPicker } from "../components/NewDmPicker.js";
import { PeerProfilePopover } from "../components/PeerProfilePopover.js";
import { RoomChatPanel } from "../components/RoomChatPanel.js";
import { ThreadHeader } from "../components/ThreadHeader.js";
import { I } from "../components/Icons.js";
import { useUnreadStore } from "../lib/unread-store.js";

type DmsScreenProps = {
  onJoinRoom?: (roomId: string) => void;
};

export function DmsScreen({ onJoinRoom }: DmsScreenProps = {}): ReactElement {
  const me = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);

  const [threads, setThreads] = useState<DmThreadEntry[]>([]);
  const [active, setActive] = useState<string | null>(null);
  const [split, setSplit] = useState<string | null>(null);
  const [chooserOpen, setChooserOpen] = useState(false);
  const [rowMenu, setRowMenu] = useState<{ threadId: string; x: number; y: number } | null>(null);
  const [blockArmed, setBlockArmed] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [friendsOpen, setFriendsOpen] = useState(false);
  const [activePeer, setActivePeer] = useState<{ id: string; handle: string | null; displayName: string } | null>(null);

  const refresh = useCallback(async () => {
    if (!token) return;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      const r = await api.dmThreads();
      setThreads(r.threads);
    } catch { /* */ }
  }, [serverUrl, token]);

  useEffect(() => {
    void refresh();
    if (!token) return;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    void useUnreadStore.getState().refresh(api);
  }, [refresh, serverUrl, token]);

  useEffect(() => {
    if (!token) return;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    for (const id of [active, split]) {
      if (!id) continue;
      void api.markRead("dm", id);
      useUnreadStore.getState().clearThread("dm", id);
    }
  }, [active, split, serverUrl, token]);

  // Split pane bookkeeping: never show the same thread twice; if the
  // primary pane closes, the split thread promotes to primary (2.4f).
  useEffect(() => {
    if (split && split === active) setSplit(null);
  }, [split, active]);
  useEffect(() => {
    if (!active && split) {
      setActive(split);
      setSplit(null);
    }
  }, [active, split]);

  // Live updates: refresh the DM thread list when a new message lands or
  // when the active thread changes (so the last-message preview stays in
  // sync). Without this, sending or receiving a message in an open thread
  // wouldn't update its preview row in the left rail until full refresh.
  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    return t.on((event) => {
      if (event.type === "message" && event.message.threadType === "dm") {
        void refresh();
      } else if (event.type === "chat.mention" && event.message.threadType === "dm") {
        void refresh();
      }
    });
  }, [refresh]);

  // Sync displayed peer when user picks an existing thread.
  useEffect(() => {
    if (!active) { setActivePeer(null); return; }
    const t = threads.find((x) => x.threadId === active);
    if (t) setActivePeer(t.otherParticipant);
  }, [active, threads]);

  const onPick = useCallback((threadId: string, peer: { id: string; handle: string | null; displayName: string }) => {
    setActive(threadId);
    setActivePeer(peer);
    void refresh();
  }, [refresh]);

  const handleJoinRoom = useCallback((roomId: string) => {
    onJoinRoom?.(roomId);
  }, [onJoinRoom]);

  const splitPeer = split
    ? (threads.find((x) => x.threadId === split)?.otherParticipant ?? null)
    : null;

  if (!me) return <div />;

  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "280px 1fr",
        height: "100%",
        background: "var(--bg)",
      }}
    >
      <aside
        style={{
          borderRight: "1px solid var(--border-soft)",
          display: "flex",
          flexDirection: "column",
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", padding: "var(--s-3) var(--s-4)" }}>
          <span style={{ fontWeight: 600, fontSize: "var(--t-md)", flex: 1 }}>Direct messages</span>
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            onClick={() => setPickerOpen(true)}
            style={{ height: "1.8rem", padding: "0 var(--s-3)", fontSize: "var(--t-sm)" }}
          >
            <I.Plus size={12} /> New
          </button>
        </div>
        {split && (
          <div
            className="rv-label"
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "var(--s-1) var(--s-4)",
              fontSize: "var(--t-2xs)",
            }}
          >
            <span>
              <span style={{ color: "var(--accent)", fontWeight: 700 }}>⫼</span> split view
            </span>
            <button
              type="button"
              onClick={() => setSplit(null)}
              style={{
                appearance: "none",
                background: "transparent",
                border: 0,
                padding: 0,
                font: "inherit",
                letterSpacing: "inherit",
                textTransform: "inherit",
                color: "var(--text-dim)",
                cursor: "pointer",
                textDecoration: "underline",
                textUnderlineOffset: 2,
              }}
            >
              close
            </button>
          </div>
        )}
        <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "var(--s-2) var(--s-3)" }}>
          <DmThreadList
            threads={threads}
            activeThreadId={active}
            splitThreadId={split}
            onSelect={setActive}
            onContextMenu={(threadId, x, y) => setRowMenu({ threadId, x, y })}
          />
        </div>
        <div style={{ borderTop: "1px solid var(--border-soft)", flexShrink: 0 }}>
          <button
            type="button"
            onClick={() => setFriendsOpen((v) => !v)}
            style={{
              width: "100%",
              padding: "var(--s-3) var(--s-4)",
              background: "transparent",
              border: 0,
              color: "var(--text)",
              cursor: "pointer",
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              fontWeight: 500,
            }}
          >
            Friends {friendsOpen ? "▾" : "▸"}
          </button>
          {friendsOpen && <FriendsPane onJoinRoom={handleJoinRoom} />}
        </div>
      </aside>

      <main
        style={{
          display: "grid",
          gridTemplateColumns: split ? "1fr 1fr" : "1fr",
          minHeight: 0,
          position: "relative",
        }}
      >
        {active && activePeer ? (
          <>
            <DmPane
              threadId={active}
              peer={activePeer}
              meId={me.id}
              meName={me.displayName}
              borderRight={split !== null}
              onJoinRoom={handleJoinRoom}
              onClose={() => setActive(null)}
              actions={
                <button
                  type="button"
                  className="rv-btn rv-btn-icon"
                  data-variant="ghost"
                  data-active={split !== null || chooserOpen}
                  title="Open another DM beside this one"
                  onClick={() => setChooserOpen((v) => !v)}
                  style={{ height: "1.8rem", width: "1.8rem", fontSize: "var(--t-md)" }}
                >
                  ⫼
                </button>
              }
            />
            {split && splitPeer && (
              <DmPane
                threadId={split}
                peer={splitPeer}
                meId={me.id}
                meName={me.displayName}
                onJoinRoom={handleJoinRoom}
                onClose={() => setSplit(null)}
                actions={
                  <button
                    type="button"
                    className="rv-btn rv-btn-icon"
                    data-variant="ghost"
                    title="Close split pane"
                    onClick={() => setSplit(null)}
                    style={{ height: "1.8rem", width: "1.8rem" }}
                  >
                    <I.X size={13} />
                  </button>
                }
              />
            )}

            {/* Split chooser (2.4e): pick the second thread */}
            {chooserOpen && (
              <div
                className="rv-menu rv-fade-in"
                style={{
                  position: "absolute",
                  top: "3rem",
                  right: "var(--s-4)",
                  width: 300,
                  zIndex: 45,
                  padding: "var(--s-3)",
                }}
              >
                <div className="rv-label" style={{ fontSize: "var(--t-2xs)", marginBottom: "var(--s-2)" }}>
                  Open another DM beside {activePeer.handle ? `@${activePeer.handle}` : activePeer.displayName}
                </div>
                {threads.filter((t) => t.threadId !== active).length === 0 ? (
                  <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)", padding: "var(--s-2)" }}>
                    No other conversations yet.
                  </div>
                ) : (
                  threads
                    .filter((t) => t.threadId !== active)
                    .slice(0, 12)
                    .map((t) => (
                      <button
                        key={t.threadId}
                        type="button"
                        className="rv-menu-item"
                        onClick={() => {
                          setSplit(t.threadId);
                          setChooserOpen(false);
                        }}
                      >
                        <span style={{ flex: 1 }}>
                          {t.otherParticipant.handle
                            ? `@${t.otherParticipant.handle}`
                            : t.otherParticipant.displayName}
                        </span>
                      </button>
                    ))
                )}
              </div>
            )}
          </>
        ) : (
          <div style={{ display: "grid", placeItems: "center", height: "100%", color: "var(--text-faint)", padding: "var(--s-7)" }}>
            <div style={{ textAlign: "center", maxWidth: 320 }}>
              <h2 style={{ fontSize: "var(--t-xl)", fontWeight: 600, color: "var(--text)", marginBottom: "var(--s-3)" }}>
                Start a conversation
              </h2>
              <p style={{ marginBottom: "var(--s-5)" }}>Click <strong>+ New</strong> to message someone by their @handle.</p>
              <button
                type="button"
                className="rv-btn"
                data-variant="primary"
                onClick={() => setPickerOpen(true)}
              >
                <I.Plus size={14} /> New conversation
              </button>
            </div>
          </div>
        )}
      </main>

      <NewDmPicker open={pickerOpen} onClose={() => setPickerOpen(false)} onPick={onPick} />

      {/* 2.4d user/thread context menu */}
      {rowMenu && (
        <ContextMenu
          x={rowMenu.x}
          y={rowMenu.y}
          onClose={() => {
            setRowMenu(null);
            setBlockArmed(false);
          }}
        >
          <MenuItem
            icon="✉"
            label="Open"
            kbd="↵"
            onClick={() => {
              setActive(rowMenu.threadId);
              setRowMenu(null);
            }}
          />
          <MenuItem
            icon="⫼"
            label="Open beside current"
            disabled={!active || active === rowMenu.threadId}
            disabledHint={!active ? "Open a conversation first." : "Already open."}
            onClick={() => {
              setSplit(rowMenu.threadId);
              setRowMenu(null);
            }}
          />
          <MenuDivider />
          <MenuItem
            icon="⛔"
            label={blockArmed ? "Really block? Click again" : "Block user"}
            tone="danger"
            onClick={() => {
              if (!blockArmed) {
                setBlockArmed(true);
                return;
              }
              const peer = threads.find((t) => t.threadId === rowMenu.threadId)?.otherParticipant;
              setRowMenu(null);
              setBlockArmed(false);
              if (!peer || !token) return;
              const api = new ApiClient(serverUrl);
              api.setToken(token);
              void api.blockUser(peer.id).then(() => refresh());
            }}
          />
        </ContextMenu>
      )}
    </div>
  );
}

// One DM column: header + chat. Used once normally, twice in split view (2.4f).
function DmPane({
  threadId,
  peer,
  meId,
  meName,
  borderRight,
  onClose,
  onJoinRoom,
  actions,
}: {
  threadId: string;
  peer: { id: string; handle: string | null; displayName: string };
  meId: string;
  meName: string;
  borderRight?: boolean;
  onClose: () => void;
  onJoinRoom?: (roomId: string) => void;
  actions?: ReactElement;
}): ReactElement {
  const [profileOpen, setProfileOpen] = useState(false);
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
        minWidth: 0,
        position: "relative",
        borderRight: borderRight ? "1px solid var(--border-soft)" : undefined,
      }}
    >
      <ThreadHeader
        threadType="dm"
        threadId={threadId}
        title={peer.displayName}
        subtitle={peer.handle ? `@${peer.handle}` : undefined}
        actions={actions}
        onTitleClick={() => setProfileOpen((v) => !v)}
        leading={
          <Avatar src={null} fallbackInitials={peer.displayName} fallbackColorSeed={peer.id} size={34} />
        }
        badge={
          <span
            title="Direct messages are end-to-end encrypted — the server can't read them."
            style={{
              marginLeft: 6,
              height: "1.15rem",
              padding: "0 7px",
              borderRadius: 999,
              background: "color-mix(in srgb, var(--ok) 8%, transparent)",
              border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)",
              color: "var(--ok)",
              fontFamily: "var(--font-mono)",
              fontSize: 9,
              letterSpacing: ".12em",
              display: "inline-flex",
              alignItems: "center",
              gap: 3,
            }}
          >
            🔒 E2EE
          </span>
        }
      />
      {profileOpen && (
        <PeerProfilePopover
          peer={peer}
          onClose={() => setProfileOpen(false)}
          {...(onJoinRoom ? { onJoinRoom } : {})}
        />
      )}
      <div style={{ flex: 1, minHeight: 0 }}>
        <RoomChatPanel
          threadType="dm"
          threadId={threadId}
          localIdentity={meId}
          localName={meName}
          variant="fill"
          onClose={onClose}
          mentionCandidates={
            peer.handle ? [{ id: peer.id, handle: peer.handle, displayName: peer.displayName }] : []
          }
        />
      </div>
    </div>
  );
}
