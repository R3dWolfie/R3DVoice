import { useEffect, useState, type ReactElement } from "react";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import type { InviteFullMetadataDTO } from "@r3dvoice/shared";

interface Props {
  code: string;
  onRedirect(redirectTo: string): void;
  onCancel(): void;
}

export function InvitePreviewScreen({ code, onRedirect, onCancel }: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [meta, setMeta] = useState<InviteFullMetadataDTO | null>(null);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    api
      .getInviteFull(code)
      .then((data) => setMeta(data as InviteFullMetadataDTO))
      .catch((e: unknown) => setError(e instanceof Error ? e.message : "failed"))
      .finally(() => setLoading(false));
  }, [code, serverUrl, token]);

  const join = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      const res = await api.redeemInvite(code);
      onRedirect(res.redirectTo);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  };

  if (loading)
    return (
      <div className="rv-card" style={{ padding: "var(--s-7)" }}>
        Loading invite…
      </div>
    );

  if (!meta)
    return (
      <div className="rv-card" style={{ padding: "var(--s-7)" }}>
        <h2>Invite not found</h2>
        <p>{error ?? "This invite may be expired or revoked."}</p>
        <button className="rv-btn" onClick={onCancel}>
          Back to lobby
        </button>
      </div>
    );

  return (
    <div style={{ display: "grid", placeItems: "center", height: "100%", padding: "var(--s-7)" }}>
      <div className="rv-card" style={{ padding: "var(--s-7)", maxWidth: 480 }}>
        <h2>
          <span style={{ color: "var(--accent)" }}>@{meta.creator.handle}</span>{" "}
          {meta.kind === "room" && meta.targetRoom ? (
            <>
              invited you to <strong>{meta.targetRoom.name}</strong>
            </>
          ) : (
            <>wants to be your friend</>
          )}
        </h2>
        {meta.kind === "room" && meta.targetRoom && (
          <p style={{ color: "var(--text-mid)" }}>
            {meta.targetRoom.memberCount} member{meta.targetRoom.memberCount === 1 ? "" : "s"}
          </p>
        )}
        {error && <p style={{ color: "var(--accent)" }}>{error}</p>}
        <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-5)" }}>
          <button
            className="rv-btn"
            data-variant="primary"
            disabled={busy}
            onClick={() => void join()}
          >
            {busy
              ? "Joining…"
              : meta.kind === "room"
                ? "Join room"
                : "Accept friend invite"}
          </button>
          <button className="rv-btn" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
