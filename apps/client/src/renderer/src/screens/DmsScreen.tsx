import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { DmThreadEntry } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { DmThreadList } from "../components/DmThreadList.js";
import { FriendsPane } from "../components/FriendsPane.js";
import { NewDmPicker } from "../components/NewDmPicker.js";
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
    if (!active || !token) return;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    void api.markRead("dm", active);
    useUnreadStore.getState().clearThread("dm", active);
  }, [active, serverUrl, token]);

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
        <div style={{ flex: "1 1 auto", overflowY: "auto", padding: "var(--s-2) var(--s-3)" }}>
          <DmThreadList threads={threads} activeThreadId={active} onSelect={setActive} />
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

      <main style={{ display: "flex", flexDirection: "column", minHeight: 0 }}>
        {active && activePeer ? (
          <>
            <ThreadHeader
              threadType="dm"
              threadId={active}
              title={activePeer.handle ? `@${activePeer.handle}` : activePeer.displayName}
              subtitle={activePeer.handle ? activePeer.displayName : undefined}
            />
            <div style={{ flex: 1, minHeight: 0 }}>
              <RoomChatPanel
                threadType="dm"
                threadId={active}
                localIdentity={me.id}
                localName={me.displayName}
                onClose={() => setActive(null)}
                mentionCandidates={activePeer.handle ? [{
                  id: activePeer.id,
                  handle: activePeer.handle,
                  displayName: activePeer.displayName,
                }] : []}
              />
            </div>
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
    </div>
  );
}
