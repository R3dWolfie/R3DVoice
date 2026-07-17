import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { PublicRoomDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { Modal } from "./Modal.js";

// Public room directory per WireFrames 4.7: filter-by-name input + "Show
// empty rooms" toggle over a two-up card grid (name · description ·
// occupancy pip + "N in voice" · Join), rooms with people in them first.
// Cards credit the owner ("by @handle") per deck 4.7.
export function PublicRoomsModal({
  onClose,
  onJoin,
}: {
  onClose: () => void;
  onJoin: (roomId: string) => void;
}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [rooms, setRooms] = useState<PublicRoomDTO[] | null>(null);
  const [filter, setFilter] = useState("");
  const [showEmpty, setShowEmpty] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      const r = await api.listPublicRooms();
      // In-voice-first sort, then by member count.
      setRooms([...r.rooms].sort((a, b) => b.inCall - a.inCall || b.memberCount - a.memberCount));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load directory");
    }
  }, [serverUrl, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  // Live occupancy: presence changes re-fetch the directory (debounced),
  // so "N in voice" counts keep breathing while the modal is open.
  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const off = t.on((event) => {
      if (event.type === "presence.update") {
        if (timer) clearTimeout(timer);
        timer = setTimeout(() => void refresh(), 800);
      }
    });
    return () => {
      off();
      if (timer) clearTimeout(timer);
    };
  }, [refresh]);

  const nameMatches = (rooms ?? []).filter((r) =>
    r.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const shown = nameMatches.filter((r) => showEmpty || r.inCall > 0);
  // Distinguish "nothing matches the filter" from "matches exist but are
  // all empty and hidden" so the empty state can point at the toggle.
  const hiddenByToggle = !showEmpty && nameMatches.length > 0 && shown.length === 0;

  return (
    <Modal
      open={true}
      onClose={onClose}
      icon="🧭"
      title="Browse public rooms"
      subtitle="Find rooms with people in them."
      width="min(94vw, 720px)"
    >
      <div
        style={{
          padding: "var(--s-4) var(--s-6)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
          minHeight: 0,
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-4)" }}>
          <input
            autoFocus
            className="rv-input"
            placeholder="Filter by name…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            style={{ height: "2.25rem", fontSize: "var(--t-sm)", flex: 1 }}
          />
          <label className="rv-check" style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", flexShrink: 0 }}>
            <input
              type="checkbox"
              checked={showEmpty}
              onChange={(e) => setShowEmpty(e.target.checked)}
            />
            <span className="rv-check-box" />
            <span>Show empty rooms</span>
          </label>
        </div>
        {error && rooms !== null && (
          // A refresh failed while a prior list is on screen — banner over the
          // stale grid. The empty-first-load case is owned by the body below.
          <div className="rv-err-banner" role="alert">
            <span className="ic">!</span>
            <div>{error}</div>
          </div>
        )}
        <div className="rv-scroll" style={{ overflowY: "auto", minHeight: 0, maxHeight: 440 }}>
          {error && rooms === null ? (
            // A failed first load must not leave the skeletons pulsing forever —
            // give the user a way out instead.
            <div className="rv-empty" style={{ padding: "var(--s-8) 0", gap: "var(--s-3)" }}>
              <span className="rv-empty-title">Couldn’t load the directory</span>
              <span className="rv-empty-hint">{error}</span>
              <button
                className="rv-btn"
                data-variant="primary"
                style={{ height: "2rem", padding: "0 var(--s-4)", fontSize: "var(--t-xs)" }}
                onClick={() => void refresh()}
              >
                Retry
              </button>
            </div>
          ) : rooms === null ? (
            <div className="rv-browse-grid">
              <div className="rv-skeleton" style={{ height: "7rem" }} />
              <div className="rv-skeleton" style={{ height: "7rem" }} />
              <div className="rv-skeleton" style={{ height: "7rem" }} />
              <div className="rv-skeleton" style={{ height: "7rem" }} />
            </div>
          ) : shown.length === 0 ? (
            <div className="rv-empty" style={{ padding: "var(--s-8) 0" }}>
              <span className="rv-empty-title">
                {rooms.length === 0
                  ? "No public rooms yet"
                  : hiddenByToggle
                    ? "No rooms live right now"
                    : "No matches"}
              </span>
              <span className="rv-empty-hint">
                {rooms.length === 0
                  ? "Make a room Public in its settings and it shows up here."
                  : hiddenByToggle
                    ? "Tick “Show empty rooms” to browse the quiet ones."
                    : "Try a different search."}
              </span>
            </div>
          ) : (
            <div className="rv-browse-grid">
              {shown.map((r) => (
                <div key={r.id} className="rv-browse-card">
                  <span className="name">{r.name}</span>
                  <span className="by">
                    by {r.owner.handle ? `@${r.owner.handle}` : r.owner.displayName} · {r.memberCount} member
                    {r.memberCount === 1 ? "" : "s"}
                  </span>
                  <span className="desc">{r.description ?? "No description yet."}</span>
                  <div className="foot">
                    <span className="rv-occupancy" data-live={r.inCall > 0 ? "true" : undefined}>
                      <span className="pip" />
                      {r.inCall > 0 ? `${r.inCall} in voice` : "Empty · be the first"}
                    </span>
                    <button
                      className="rv-btn"
                      data-variant="primary"
                      style={{ height: "2rem", padding: "0 var(--s-4)", fontSize: "var(--t-xs)" }}
                      onClick={() => {
                        onClose();
                        onJoin(r.id);
                      }}
                    >
                      Join
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
