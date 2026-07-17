import { useEffect, useState, type ReactElement } from "react";
import type { RoomDTO, RoomMemberDTO } from "@r3dvoice/shared";
import { ApiClient, ApiError } from "../lib/api.js";
import { useAuthStore } from "../lib/auth-context.js";
import { I } from "./Icons.js";
import { InviteCreateModal } from "./InviteCreateModal.js";

interface Props {
  roomId: string;
  /** Called when the room is deleted or the user leaves so the parent can route them out. */
  onDeparture: () => void;
  /** Called by the close button in the panel header. */
  onClose: () => void;
}

type DangerConfirm = "delete" | "leave" | null;

/**
 * In-room popover showing room metadata + members + access-control actions.
 * Owner sees the full surface (visibility toggle, invite, remove, transfer,
 * delete). Non-owners see members + a Leave button. Confirmation modals for
 * destructive actions (delete / leave / transfer / remove).
 */
export function RoomInfoPanel({ roomId, onDeparture, onClose }: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const me = useAuthStore((s) => s.user);

  const [room, setRoom] = useState<RoomDTO | null>(null);
  const [members, setMembers] = useState<RoomMemberDTO[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busyAction, setBusyAction] = useState(false);
  const [danger, setDanger] = useState<DangerConfirm>(null);
  const [transferTargetId, setTransferTargetId] = useState<string | null>(null);
  const [removeTargetId, setRemoveTargetId] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const api = (() => {
    const a = new ApiClient(serverUrl);
    if (token) a.setToken(token);
    return a;
  })();

  const isOwner = room ? room.ownerId === me?.id : false;

  async function load(): Promise<void> {
    setLoading(true);
    setError(null);
    try {
      const [r, ms] = await Promise.all([api.getRoom(roomId), api.listRoomMembers(roomId)]);
      setRoom(r);
      setMembers(ms);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "failed to load room");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [roomId]);

  async function withBusy(fn: () => Promise<void>): Promise<void> {
    setBusyAction(true);
    setError(null);
    try {
      await fn();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "action failed");
    } finally {
      setBusyAction(false);
    }
  }

  async function toggleVisibility(): Promise<void> {
    if (!room) return;
    await withBusy(async () => {
      const updated = await api.updateRoom(roomId, { isPublic: !room.isPublic });
      setRoom(updated);
    });
  }

  async function confirmRemove(): Promise<void> {
    if (!removeTargetId) return;
    const id = removeTargetId;
    setRemoveTargetId(null);
    await withBusy(async () => {
      await api.removeRoomMember(roomId, id);
      setMembers((prev) => prev.filter((x) => x.userId !== id));
    });
  }

  async function confirmTransfer(): Promise<void> {
    if (!transferTargetId) return;
    const id = transferTargetId;
    setTransferTargetId(null);
    await withBusy(async () => {
      const updated = await api.transferRoomOwnership(roomId, id);
      setRoom(updated);
      setMembers((prev) =>
        prev.map((m) => ({
          ...m,
          isOwner: m.userId === updated.ownerId,
        })),
      );
    });
  }

  async function confirmDelete(): Promise<void> {
    setDanger(null);
    await withBusy(async () => {
      await api.deleteRoom(roomId);
      onDeparture();
    });
  }

  async function confirmLeave(): Promise<void> {
    setDanger(null);
    await withBusy(async () => {
      await api.leaveRoom(roomId);
      onDeparture();
    });
  }

  return (
    <div
      data-rv-pop=""
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        top: 56,
        left: "var(--s-5)",
        zIndex: 30,
        width: 360,
        maxHeight: "calc(100vh - 80px)",
        overflowY: "auto",
        padding: "var(--s-4) var(--s-5)",
        background: "var(--bg-elev-2)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-md)",
        boxShadow: "var(--shadow-2)",
        backdropFilter: "blur(8px)",
      }}
    >
      <div className="rv-section-head" style={{ marginBottom: "var(--s-3)" }}>
        <span className="rv-label">Room</span>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close"
          style={{
            marginLeft: "auto",
            appearance: "none",
            border: 0,
            background: "transparent",
            color: "var(--text-faint)",
            cursor: "pointer",
            padding: 2,
          }}
        >
          <I.X size={12} />
        </button>
      </div>

      {loading ? (
        <div style={{ color: "var(--text-faint)", fontSize: "var(--t-xs)" }}>Loading…</div>
      ) : error && !room ? (
        <div style={{ color: "var(--accent-glow)", fontSize: "var(--t-sm)" }}>{error}</div>
      ) : room ? (
        <>
          {/* Metadata */}
          <KV
            label="ID"
            value={
              <span className="rv-mono" style={{ fontSize: 10 }}>
                {roomId.slice(0, 16)}…
              </span>
            }
          />
          <KV
            label="Visibility"
            value={
              isOwner ? (
                <button
                  type="button"
                  onClick={() => void toggleVisibility()}
                  disabled={busyAction}
                  className="rv-btn"
                  data-variant="ghost"
                  style={{ height: "1.6rem", fontSize: "var(--t-xs)" }}
                >
                  {room.isPublic ? "🌐 Public" : "🔒 Private"} — click to flip
                </button>
              ) : (
                <span>{room.isPublic ? "🌐 Public" : "🔒 Private"}</span>
              )
            }
          />
          <KV label="Codec" value="OPUS · 48 kHz" />

          {/* Members */}
          <div className="rv-section-head" style={{ marginTop: "var(--s-5)" }}>
            <span className="rv-label">Members</span>
            <span
              className="rv-mono"
              style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}
            >
              {members.length}
            </span>
          </div>
          <div className="rv-list" style={{ marginBottom: "var(--s-3)" }}>
            {members.map((m) => (
              <div
                key={m.userId}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-2)",
                  padding: "6px 8px",
                  borderRadius: "var(--r-sm)",
                }}
              >
                <span style={{ fontSize: "var(--t-sm)", flex: 1 }}>
                  {m.isOwner && <I.StarFilled size={10} style={{ color: "var(--rv-amber)", marginRight: 4 }} />}
                  {m.displayName}
                  {m.userId === me?.id && (
                    <span style={{ color: "var(--text-faint)" }}> (you)</span>
                  )}
                </span>
                {isOwner && !m.isOwner && (
                  <>
                    <button
                      type="button"
                      onClick={() => setTransferTargetId(m.userId)}
                      disabled={busyAction}
                      className="rv-btn"
                      data-variant="ghost"
                      title="Transfer ownership to this member"
                      style={{ height: "1.5rem", fontSize: 10, padding: "0 6px" }}
                    >
                      Transfer
                    </button>
                    <button
                      type="button"
                      onClick={() => setRemoveTargetId(m.userId)}
                      disabled={busyAction}
                      className="rv-btn"
                      data-variant="ghost"
                      title="Remove from room"
                      style={{ height: "1.5rem", fontSize: 10, padding: "0 6px" }}
                    >
                      Remove
                    </button>
                  </>
                )}
              </div>
            ))}
          </div>

          {/* Invite to room */}
          <div style={{ marginBottom: "var(--s-4)" }}>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              onClick={() => setInviteOpen(true)}
              style={{ width: "100%", fontSize: "var(--t-xs)" }}
            >
              Invite to room
            </button>
            <InviteCreateModal
              open={inviteOpen}
              onClose={() => setInviteOpen(false)}
              roomId={roomId}
            />
          </div>

          {/* Danger zone */}
          <div className="rv-section-head" style={{ marginTop: "var(--s-4)" }}>
            <span className="rv-label" style={{ color: "var(--accent-glow)" }}>
              Danger
            </span>
          </div>
          <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
            {isOwner ? (
              <button
                type="button"
                onClick={() => setDanger("delete")}
                disabled={busyAction}
                className="rv-btn"
                data-variant="ghost"
                style={{
                  fontSize: "var(--t-xs)",
                  color: "var(--accent-glow)",
                  borderColor: "color-mix(in oklch, var(--accent) 30%, transparent)",
                }}
              >
                Delete room…
              </button>
            ) : (
              <button
                type="button"
                onClick={() => setDanger("leave")}
                disabled={busyAction}
                className="rv-btn"
                data-variant="ghost"
                style={{ fontSize: "var(--t-xs)" }}
              >
                Leave room…
              </button>
            )}
          </div>

          {error && (
            <div
              style={{
                marginTop: "var(--s-3)",
                color: "var(--accent-glow)",
                fontSize: "var(--t-xs)",
              }}
            >
              {error}
            </div>
          )}
        </>
      ) : null}

      {/* Confirmation overlays */}
      {danger === "delete" && (
        <ConfirmOverlay
          title="Delete room?"
          body="The room and its membership list will be removed. Anyone currently connected will be disconnected. This cannot be undone."
          confirmLabel="Delete"
          danger
          onConfirm={() => void confirmDelete()}
          onCancel={() => setDanger(null)}
        />
      )}
      {danger === "leave" && (
        <ConfirmOverlay
          title="Leave room?"
          body="You'll be removed from the room's member list. The owner will need to re-invite you to come back."
          confirmLabel="Leave"
          onConfirm={() => void confirmLeave()}
          onCancel={() => setDanger(null)}
        />
      )}
      {transferTargetId && (
        <ConfirmOverlay
          title="Transfer ownership?"
          body={`${members.find((m) => m.userId === transferTargetId)?.displayName ?? "This user"} will become the room owner. You'll stay as a regular member.`}
          confirmLabel="Transfer"
          onConfirm={() => void confirmTransfer()}
          onCancel={() => setTransferTargetId(null)}
        />
      )}
      {removeTargetId && (
        <ConfirmOverlay
          title="Remove member?"
          body={`${members.find((m) => m.userId === removeTargetId)?.displayName ?? "This user"} will lose access to the room and be disconnected if they're currently in it.`}
          confirmLabel="Remove"
          danger
          onConfirm={() => void confirmRemove()}
          onCancel={() => setRemoveTargetId(null)}
        />
      )}
    </div>
  );
}

function KV({ label, value }: { label: string; value: ReactElement | string }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "4px 0",
        borderBottom: "1px dashed var(--border-soft)",
        fontSize: "var(--t-sm)",
      }}
    >
      <span style={{ color: "var(--text-faint)", fontSize: "var(--t-xs)" }}>{label}</span>
      <span>{value}</span>
    </div>
  );
}

function ConfirmOverlay({
  title,
  body,
  confirmLabel,
  danger,
  onConfirm,
  onCancel,
}: {
  title: string;
  body: string;
  confirmLabel: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}): ReactElement {
  return (
    <div
      data-rv-pop=""
      onClick={(e) => e.stopPropagation()}
      onMouseDown={(e) => e.stopPropagation()}
      style={{
        position: "fixed",
        inset: 0,
        background: "color-mix(in oklch, var(--rv-ink-0) 70%, transparent)",
        zIndex: 40,
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        style={{
          background: "var(--bg-elev-2)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-md)",
          padding: "var(--s-5) var(--s-6)",
          width: "min(420px, 90vw)",
          boxShadow: "var(--shadow-3)",
        }}
      >
        <div style={{ fontWeight: 600, fontSize: "var(--t-md)", marginBottom: "var(--s-3)" }}>
          {title}
        </div>
        <div style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)", marginBottom: "var(--s-5)" }}>
          {body}
        </div>
        <div style={{ display: "flex", gap: "var(--s-3)", justifyContent: "flex-end" }}>
          <button type="button" className="rv-btn" onClick={onCancel}>
            Cancel
          </button>
          <button
            type="button"
            className="rv-btn"
            data-variant={danger ? undefined : "primary"}
            onClick={onConfirm}
            style={
              danger
                ? {
                    background: "var(--accent)",
                    color: "var(--on-accent)",
                  }
                : {}
            }
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
