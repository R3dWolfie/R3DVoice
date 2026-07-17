import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { InviteDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { pushToast } from "../lib/toast-store.js";
import { I } from "./Icons.js";

// 2.3 — manage invite links: each row shows the full URL (mono) with a
// "RoomName · 2/10 uses · expires May 30" meta line, a per-row copy button
// (confirmation via the toast host) and Revoke.

function metaLine(inv: InviteDTO, roomName: string | null): string {
  const target = inv.kind === "friend" ? "Friend invite" : (roomName ?? "Room");
  const uses =
    inv.maxUses != null ? `${inv.uses}/${inv.maxUses} uses` : `${inv.uses} use${inv.uses === 1 ? "" : "s"}`;
  const expiry = inv.expiresAt
    ? `expires ${new Date(inv.expiresAt).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`
    : "never expires";
  return `${target} · ${uses} · ${expiry}${inv.revokedAt ? " · revoked" : ""}`;
}

export function MyInvitesList(): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [rows, setRows] = useState<InviteDTO[]>([]);
  const [roomNames, setRoomNames] = useState<Record<string, string>>({});
  const [loading, setLoading] = useState(false);

  const refresh = useCallback(async () => {
    setLoading(true);
    const api = new ApiClient(serverUrl); api.setToken(token);
    try {
      const r = await api.listMyInvites();
      setRows(r.invites);
      // Resolve room names for room invites (2.3 shows "Studio Floor · …").
      if (r.invites.some((i) => i.targetRoomId !== null)) {
        try {
          const rooms = await api.listRooms();
          const map: Record<string, string> = {};
          for (const room of [...rooms.owned, ...rooms.recent]) map[room.id] = room.name;
          setRoomNames(map);
        } catch { /* meta falls back to "Room" */ }
      }
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

  const copy = useCallback(async (inv: InviteDTO) => {
    const url = `${serverUrl.replace(/\/$/, "")}/invite/${inv.code}`;
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ kind: "success", text: "Invite link copied", sub: url });
    } catch {
      pushToast({ kind: "error", text: "Couldn't access the clipboard" });
    }
  }, [serverUrl]);

  if (loading && rows.length === 0) return <p>Loading invites…</p>;
  if (rows.length === 0) return <p style={{ color: "var(--text-faint)" }}>No active invites.</p>;

  return (
    <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
      {rows.map((inv) => (
        <li
          key={inv.id}
          style={{
            display: "flex",
            gap: "var(--s-3)",
            alignItems: "center",
            padding: "var(--s-3) 0",
            borderBottom: "1px solid var(--border-soft)",
            opacity: inv.revokedAt ? 0.55 : 1,
          }}
        >
          <div style={{ flex: 1, minWidth: 0 }}>
            <div
              className="rv-mono"
              style={{
                fontSize: "var(--t-sm)",
                overflow: "hidden",
                textOverflow: "ellipsis",
                whiteSpace: "nowrap",
              }}
            >
              {serverUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}/invite/{inv.code}
            </div>
            <div style={{ color: "var(--text-dim)", fontSize: "var(--t-xs)", marginTop: 2 }}>
              {metaLine(inv, inv.targetRoomId ? (roomNames[inv.targetRoomId] ?? null) : null)}
            </div>
          </div>
          {!inv.revokedAt && (
            <>
              <button
                className="rv-btn rv-btn-icon"
                data-variant="ghost"
                title="Copy link"
                aria-label="Copy link"
                onClick={() => void copy(inv)}
              >
                <I.Copy size={14} />
              </button>
              <button className="rv-btn" data-variant="ghost" onClick={() => void revoke(inv.id)}>
                Revoke
              </button>
            </>
          )}
        </li>
      ))}
    </ul>
  );
}
