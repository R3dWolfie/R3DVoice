import { useState, type ReactElement } from "react";
import { Modal } from "./Modal.js";
import { Field } from "./Primitives.js";

// Create-room modal per WireFrames 4.8. The deck also specs Description and
// a third "Private" (invite-only) privacy level — both need server support
// (room settings, phase 6), so this ships the real subset: name + the
// isPublic flag as Public/Unlisted.
export function CreateRoomModal({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, isPublic: boolean) => void;
  busy?: boolean;
}): ReactElement | null {
  const [name, setName] = useState("");
  const [isPublic, setIsPublic] = useState(true);

  const canCreate = !busy && name.trim().length > 0;

  return (
    <Modal
      open={open}
      onClose={onClose}
      icon="+"
      title="New room"
      width="min(92vw, 480px)"
      footer={
        <>
          <button className="rv-btn" data-variant="ghost" onClick={onClose}>
            Cancel
          </button>
          <button
            className="rv-btn"
            data-variant="primary"
            data-disabled={!canCreate || undefined}
            onClick={() => {
              if (canCreate) onCreate(name.trim(), isPublic);
            }}
          >
            {busy ? "Creating…" : "Create room"}
          </button>
        </>
      }
    >
      <div style={{ padding: "var(--s-5) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
        <Field label="Name">
          <input
            autoFocus
            className="rv-input"
            placeholder="e.g. Studio Floor"
            value={name}
            maxLength={80}
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter" && canCreate) onCreate(name.trim(), isPublic);
            }}
          />
        </Field>

        <Field
          label="Privacy"
          hint={
            isPublic
              ? "Anyone can join; listed in the public directory."
              : "Anyone with the link can join; hidden from browse."
          }
        >
          <div className="rv-seg" style={{ alignSelf: "flex-start" }}>
            <button
              type="button"
              className="rv-seg-btn"
              data-active={isPublic}
              onClick={() => setIsPublic(true)}
            >
              Public
            </button>
            <button
              type="button"
              className="rv-seg-btn"
              data-active={!isPublic}
              onClick={() => setIsPublic(false)}
            >
              Unlisted
            </button>
          </div>
        </Field>
      </div>
    </Modal>
  );
}
