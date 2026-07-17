import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { PublicRoomDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { Modal } from "./Modal.js";

// Public room directory per WireFrames 4.7: browse rooms that opted into
// listing, sorted with the populated ones first, filter by name, one-click
// join.
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
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    try {
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      const r = await api.listPublicRooms();
      setRooms([...r.rooms].sort((a, b) => b.memberCount - a.memberCount));
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to load directory");
    }
  }, [serverUrl, token]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const shown = (rooms ?? []).filter((r) =>
    r.name.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  return (
    <ModalShell onClose={onClose}>
      <div style={{ padding: "var(--s-4) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-3)", minHeight: 0 }}>
        <input
          autoFocus
          className="rv-input"
          placeholder="Filter rooms…"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          style={{ height: "2.1rem", fontSize: "var(--t-sm)" }}
        />
        {error && (
          <div className="rv-err-banner" role="alert">
            <span className="ic">!</span>
            <div>{error}</div>
          </div>
        )}
        <div className="rv-scroll" style={{ overflowY: "auto", minHeight: 0, maxHeight: 340 }}>
          {rooms === null ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
              <div className="rv-skeleton" style={{ height: "3rem" }} />
              <div className="rv-skeleton" style={{ height: "3rem" }} />
            </div>
          ) : shown.length === 0 ? (
            <div className="rv-empty" style={{ padding: "var(--s-8) 0" }}>
              <span className="rv-empty-title">
                {rooms.length === 0 ? "No public rooms yet" : "No matches"}
              </span>
              <span className="rv-empty-hint">
                {rooms.length === 0
                  ? "Make a room Public in its settings and it shows up here."
                  : "Try a different search."}
              </span>
            </div>
          ) : (
            shown.map((r) => (
              <div
                key={r.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  padding: "var(--s-3) var(--s-2)",
                  borderBottom: "1px solid var(--border-soft)",
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
                    fontFamily: "var(--font-mono)",
                    fontSize: "var(--t-xs)",
                    fontWeight: 700,
                    color: "var(--text-mid)",
                    flexShrink: 0,
                  }}
                >
                  {r.name
                    .split(" ")
                    .map((s) => s[0] ?? "")
                    .slice(0, 2)
                    .join("")
                    .toUpperCase()}
                </div>
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>{r.name}</div>
                  <div
                    style={{
                      fontSize: "var(--t-xs)",
                      color: "var(--text-dim)",
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {r.description ?? "No description"}
                    <span className="rv-mono" style={{ marginLeft: 8, color: "var(--text-faint)" }}>
                      {r.memberCount} member{r.memberCount === 1 ? "" : "s"}
                    </span>
                  </div>
                </div>
                <button
                  className="rv-btn"
                  data-variant="primary"
                  style={{ height: "1.9rem", fontSize: "var(--t-xs)" }}
                  onClick={() => {
                    onClose();
                    onJoin(r.id);
                  }}
                >
                  Join ›
                </button>
              </div>
            ))
          )}
        </div>
      </div>
    </ModalShell>
  );
}

function ModalShell({ onClose, children }: { onClose: () => void; children: ReactElement }): ReactElement {
  return (
    <Modal
      open={true}
      onClose={onClose}
      icon="🧭"
      title="Browse public rooms"
      subtitle="Find rooms with people in them."
      width="min(94vw, 560px)"
    >
      {children}
    </Modal>
  );
}
