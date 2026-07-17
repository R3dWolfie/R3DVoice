import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { InviteDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";

export function MyInvitesList(): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<InviteDTO[]>([]);
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const api = new ApiClient(serverUrl); api.setToken(token);
    try {
      const r = await api.listMyInvites();
      setRows(r.invites);
    } finally { setLoading(false); }
  }, [serverUrl, token]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live update: bump the row when someone redeems one of our invites so
  // the uses count reflects reality immediately.
  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    return t.on((event) => {
      if (event.type === "invite.redeemed") void refresh();
    });
  }, [refresh]);

  const revoke = useCallback(async (id: string) => {
    const api = new ApiClient(serverUrl); api.setToken(token);
    await api.revokeInvite(id);
    await refresh();
  }, [serverUrl, token, refresh]);

  if (loading && rows.length === 0) return <p>Loading invites…</p>;
  if (rows.length === 0) return <p style={{ color: "var(--text-faint)" }}>No active invites.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {rows.map((inv) => (
        <li key={inv.id} style={{ display: "flex", gap: "var(--s-3)", alignItems: "center", padding: "var(--s-2) 0", borderBottom: "1px solid var(--border-soft)" }}>
          <span style={{ fontFamily: "var(--font-mono)" }}>{inv.code}</span>
          <span style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)" }}>
            {inv.kind} · {inv.uses} uses{inv.maxUses != null ? ` / ${inv.maxUses}` : ""}
            {inv.expiresAt ? ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}` : " · never expires"}
            {inv.revokedAt ? " · revoked" : ""}
          </span>
          {!inv.revokedAt && (
            <button className="rv-btn" data-variant="ghost" style={{ marginLeft: "auto" }} onClick={() => void revoke(inv.id)}>
              Revoke
            </button>
          )}
        </li>
      ))}
    </ul>
  );
}
