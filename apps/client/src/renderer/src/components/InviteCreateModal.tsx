import { useCallback, useState, type ReactElement } from "react";
import { Modal } from "./Modal.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { CopyableInvite } from "./CopyableInvite.js";

type Props = {
  open: boolean;
  onClose(): void;
  /** When set, generates a kind="room" invite. Otherwise kind="friend". */
  roomId?: string;
};

const EXPIRY_OPTIONS: { label: string; ms: number | null }[] = [
  { label: "1 hour", ms: 3_600_000 },
  { label: "1 day", ms: 86_400_000 },
  { label: "7 days", ms: 7 * 86_400_000 },
  { label: "Never", ms: null },
];

export function InviteCreateModal({ open, onClose, roomId }: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [oneTime, setOneTime] = useState(false);
  const [expiryMs, setExpiryMs] = useState<number | null>(EXPIRY_OPTIONS[2]!.ms); // 7 days default
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      const expiresAt = expiryMs === null ? null : new Date(Date.now() + expiryMs).toISOString();
      const res = await api.createInvite({
        kind: roomId ? "room" : "friend",
        ...(roomId !== undefined && { targetRoomId: roomId }),
        expiresAt,
        maxUses: oneTime ? 1 : null,
      }) as { code: string };
      setCode(res.code);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }, [serverUrl, token, roomId, oneTime, expiryMs]);

  const reset = useCallback(() => {
    setCode(null);
    setError(null);
    onClose();
  }, [onClose]);

  return (
    <Modal open={open} onClose={reset} title={roomId ? "Invite to this room" : "Invite a friend"} width="min(92vw, 460px)">
      {!code && (
        <>
          <label style={{ display: "block", marginBottom: "var(--s-3)" }}>
            <span style={{ display: "block", fontSize: "var(--t-sm)", color: "var(--text-mid)" }}>Expires</span>
            <select
              className="rv-input"
              value={expiryMs ?? "null"}
              onChange={(e) => setExpiryMs(e.target.value === "null" ? null : Number(e.target.value))}
            >
              {EXPIRY_OPTIONS.map((o) => (
                <option key={o.label} value={o.ms ?? "null"}>{o.label}</option>
              ))}
            </select>
          </label>
          <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center", marginBottom: "var(--s-4)" }}>
            <input type="checkbox" checked={oneTime} onChange={(e) => setOneTime(e.target.checked)} />
            <span>One-time use</span>
          </label>
          {error && <p style={{ color: "var(--danger)" }}>{error}</p>}
          <button
            className="rv-btn"
            data-variant="primary"
            disabled={busy}
            onClick={() => void generate()}
            style={{ width: "100%" }}
          >
            {busy ? "generating…" : "Generate link"}
          </button>
        </>
      )}
      {code && <CopyableInvite code={code} serverUrl={serverUrl} onClose={reset} />}
    </Modal>
  );
}
