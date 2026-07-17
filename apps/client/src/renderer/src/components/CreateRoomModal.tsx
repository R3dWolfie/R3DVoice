import { useState, type ReactElement } from "react";
import { Modal } from "./Modal.js";
import { Field } from "./Primitives.js";

// Create-room modal per WireFrames 4.8: name, description, Public/Unlisted.
// The third "Private" (invite-only) level lands with the visibility tier.
export function CreateRoomModal({
  open,
  onClose,
  onCreate,
  busy,
}: {
  open: boolean;
  onClose: () => void;
  onCreate: (name: string, isPublic: boolean, description?: string) => void;
  busy?: boolean;
}): ReactElement | null {
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
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
              if (canCreate) onCreate(name.trim(), isPublic, description.trim() || undefined);
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
              if (e.key === "Enter" && canCreate) onCreate(name.trim(), isPublic, description.trim() || undefined);
            }}
          />
        </Field>

        <Field label="Description" hint="Optional — recommended if you list it publicly.">
          <textarea
            className="rv-input"
            value={description}
            maxLength={500}
            onChange={(e) => setDescription(e.target.value)}
            placeholder="What's this room for?"
            style={{ height: "4rem", padding: "var(--s-2) var(--s-3)", resize: "vertical", fontFamily: "inherit" }}
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
