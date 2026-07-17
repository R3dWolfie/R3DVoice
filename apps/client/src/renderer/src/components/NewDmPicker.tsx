import { useCallback, useState, type ReactElement } from "react";
import { Modal } from "./Modal.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { dmThreadId } from "../lib/dm-thread-id.js";

type Props = {
  open: boolean;
  onClose(): void;
  /** Called once a peer is resolved. Caller routes to that thread. */
  onPick(threadId: string, peer: { id: string; handle: string | null; displayName: string }): void;
};

export function NewDmPicker({ open, onClose, onPick }: Props): ReactElement {
  const me = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [value, setValue] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = useCallback(async () => {
    if (!me) return;
    const raw = value.trim().replace(/^@/, "");
    if (!raw) return;
    setBusy(true); setError(null);
    const api = new ApiClient(serverUrl); api.setToken(token);
    try {
      const peer = await api.getUserByHandle(raw);
      const threadId = dmThreadId(me.id, peer.id);
      onPick(threadId, peer);
      setValue("");
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "user not found");
    } finally {
      setBusy(false);
    }
  }, [me, serverUrl, token, value, onPick, onClose]);

  return (
    <Modal open={open} onClose={onClose} title="Start a conversation" width="min(92vw, 420px)">
      <p style={{ color: "var(--text-mid)", marginBottom: "var(--s-3)" }}>
        Type the @handle of the person you want to message.
      </p>
      <input
        autoFocus
        className="rv-input"
        placeholder="@handle"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => { if (e.key === "Enter") void submit(); }}
      />
      {error && <p style={{ color: "var(--danger)", marginTop: "var(--s-2)", fontSize: "var(--t-sm)" }}>{error}</p>}
      <button
        className="rv-btn"
        data-variant="primary"
        disabled={busy || !value.trim()}
        onClick={() => void submit()}
        style={{ marginTop: "var(--s-4)", width: "100%" }}
      >
        {busy ? "Looking up…" : "Open conversation"}
      </button>
    </Modal>
  );
}
