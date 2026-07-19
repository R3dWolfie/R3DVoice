import { useMemo, useState, type ReactElement } from "react";
import type { RoomDTO, RoomMemberDTO } from "@r3dvoice/shared";
import type { ApiClient } from "../lib/api.js";
import { pushToast } from "../lib/toast-store.js";
import { Modal } from "./Modal.js";
import { Avatar } from "./Avatar.js";

// 4.17 - transfer room ownership. Impact bullets, member picker with filter,
// type-the-room-name gate, optional "also leave" checkbox. Footer primary
// reads "Transfer to @name" once a member is picked.
export function TransferOwnershipModal({
  room,
  members,
  preselectedUserId,
  api,
  onClose,
  onDone,
}: {
  room: RoomDTO;
  members: RoomMemberDTO[];
  preselectedUserId?: string | undefined;
  api: () => ApiClient;
  onClose: () => void;
  /** Transfer succeeded; `left` = the "also leave" box was checked. */
  onDone: (left: boolean) => void;
}): ReactElement {
  const candidates = useMemo(() => members.filter((m) => !m.isOwner), [members]);
  const [selectedId, setSelectedId] = useState<string | null>(
    preselectedUserId != null && candidates.some((m) => m.userId === preselectedUserId)
      ? preselectedUserId
      : null,
  );
  const [filter, setFilter] = useState("");
  const [confirmText, setConfirmText] = useState("");
  const [alsoLeave, setAlsoLeave] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const selected = candidates.find((m) => m.userId === selectedId) ?? null;
  const nameMatches = confirmText === room.name;
  const canTransfer = selected !== null && nameMatches && !busy;

  const filtered = candidates.filter((m) =>
    m.displayName.toLowerCase().includes(filter.trim().toLowerCase()),
  );

  const transfer = async (): Promise<void> => {
    if (!selected) return;
    setBusy(true);
    setError(null);
    try {
      await api().transferRoomOwnership(room.id, selected.userId);
      if (alsoLeave) {
        await api().leaveRoom(room.id);
      }
      pushToast({
        kind: "success",
        text: `Transferred ${room.name} to ${selected.displayName}`,
        sub: alsoLeave ? "You left the room" : "You're now a regular member",
      });
      onDone(alsoLeave);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to transfer");
      setBusy(false);
    }
  };

  return (
    <Modal
      open={true}
      onClose={onClose}
      icon="⇄"
      title={`Transfer ownership of ${room.name}`}
      subtitle="Pick a member to become the new owner. You'll lose owner controls immediately."
      width="min(94vw, 520px)"
      footer={
        <>
          <span style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
            This can only be undone by the new owner.
          </span>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              data-disabled={!canTransfer || undefined}
              onClick={() => {
                if (canTransfer) void transfer();
              }}
            >
              {busy
                ? "Transferring…"
                : selected
                  ? `Transfer to ${selected.displayName}`
                  : "Transfer ownership"}
            </button>
          </div>
        </>
      }
    >
      <div style={{ padding: "var(--s-5) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
        {error && (
          <div className="rv-err-banner" role="alert">
            <span className="ic">!</span>
            <div>{error}</div>
          </div>
        )}

        {/* Impact list */}
        <div
          style={{
            padding: "var(--s-3) var(--s-4)",
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-md)",
            fontSize: "var(--t-sm)",
            lineHeight: 1.55,
          }}
        >
          <div style={{ fontWeight: 600, marginBottom: "var(--s-1)" }}>
            What happens when you transfer:
          </div>
          <ul style={{ margin: 0, paddingLeft: "1.1rem", color: "var(--text-mid)" }}>
            <li>The new owner can rename, delete, kick, and manage invites.</li>
            <li>You become a regular member - you can leave any time.</li>
            <li>Existing invite links keep working.</li>
            <li>Members will see the ownership change immediately.</li>
          </ul>
        </div>

        {/* New owner picker */}
        <div className="rv-field">
          <span className="rv-label">New owner</span>
          <input
            className="rv-input"
            placeholder="Filter members…"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
          />
          <div className="rv-scroll" style={{ maxHeight: 190, overflowY: "auto", display: "flex", flexDirection: "column", gap: 2 }}>
            {filtered.length === 0 && (
              <div style={{ padding: "var(--s-3)", fontSize: "var(--t-sm)", color: "var(--text-dim)" }}>
                {candidates.length === 0
                  ? "No other members - invite someone before transferring."
                  : "No members match that filter."}
              </div>
            )}
            {filtered.map((m) => (
              <button
                key={m.userId}
                type="button"
                className="rv-list-item"
                data-active={m.userId === selectedId}
                style={{ width: "100%", textAlign: "left", background: m.userId === selectedId ? undefined : "transparent" }}
                onClick={() => setSelectedId(m.userId)}
              >
                <Avatar src={null} fallbackInitials={m.displayName} fallbackColorSeed={m.userId} size={30} />
                <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                  <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>{m.displayName}</span>
                  <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                    joined {new Date(m.joinedAt).toLocaleDateString()}
                  </span>
                </span>
                <span
                  className="rv-badge"
                  style={{ height: "1.3rem", fontSize: "var(--t-2xs)" }}
                >
                  Member
                </span>
              </button>
            ))}
          </div>
        </div>

        {/* Type-name gate */}
        <div className="rv-field">
          <span style={{ fontSize: "var(--t-sm)", color: "var(--text-mid)" }}>
            Type <b style={{ fontWeight: 600, color: "var(--text)" }}>{room.name}</b> to confirm
            transfer.
          </span>
          <input
            className="rv-input"
            value={confirmText}
            onChange={(e) => setConfirmText(e.target.value)}
            placeholder={room.name}
            spellCheck={false}
          />
        </div>

        <label className="rv-check">
          <input
            type="checkbox"
            checked={alsoLeave}
            onChange={(e) => setAlsoLeave(e.target.checked)}
          />
          <span className="rv-check-box" />
          <span style={{ fontSize: "var(--t-sm)" }}>Also leave the room after transferring</span>
        </label>
      </div>
    </Modal>
  );
}
