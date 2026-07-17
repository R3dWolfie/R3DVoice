import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Modal } from "./Modal.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { CopyableInvite } from "./CopyableInvite.js";
import { Avatar } from "./Avatar.js";
import type { FriendDTO } from "@r3dvoice/shared";

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
  // 4.16 invite-friends: directed person-to-person invites (bell Invites tab),
  // alongside the shareable link below. Room invites only.
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const [invited, setInvited] = useState<Record<string, "sent" | "error">>({});

  useEffect(() => {
    if (!open || !roomId) return;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    let cancelled = false;
    void api
      .friends()
      .then((r) => {
        if (!cancelled) setFriends(r.friends.filter((f) => f.status === "accepted"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, roomId, serverUrl, token]);

  const inviteFriend = useCallback(
    async (userId: string) => {
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      try {
        await api.roomInviteUser(roomId!, userId);
        setInvited((m) => ({ ...m, [userId]: "sent" }));
      } catch {
        setInvited((m) => ({ ...m, [userId]: "error" }));
      }
    },
    [serverUrl, token, roomId],
  );

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
      {!code && roomId && friends.length > 0 && (
        <div style={{ marginBottom: "var(--s-5)" }}>
          <div
            className="rv-mono"
            style={{
              fontSize: "var(--t-2xs)",
              letterSpacing: ".14em",
              textTransform: "uppercase",
              color: "var(--text-faint)",
              marginBottom: "var(--s-2)",
            }}
          >
            Invite friends
          </div>
          <div className="rv-scroll" style={{ maxHeight: 180, overflow: "auto" }}>
            {friends.map((f) => (
              <div
                key={f.user.id}
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  padding: "var(--s-2)",
                  borderRadius: "var(--r-sm)",
                }}
              >
                <Avatar
                  src={f.user.avatarUrl ?? null}
                  fallbackInitials={f.user.displayName}
                  fallbackColorSeed={f.user.id}
                  size={28}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: "var(--t-xs)", fontWeight: 600, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                    {f.user.displayName}
                  </div>
                  {f.user.currentRoom && (
                    <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                      in voice · {f.user.currentRoom.name}
                    </div>
                  )}
                </div>
                <button
                  className="rv-btn"
                  data-variant={invited[f.user.id] === "sent" ? undefined : "primary"}
                  disabled={invited[f.user.id] === "sent"}
                  style={{ height: "1.7rem", fontSize: "var(--t-2xs)", padding: "0 var(--s-3)" }}
                  onClick={() => void inviteFriend(f.user.id)}
                >
                  {invited[f.user.id] === "sent" ? "Invited ✓" : invited[f.user.id] === "error" ? "Retry" : "Invite"}
                </button>
              </div>
            ))}
          </div>
          <div
            style={{
              margin: "var(--s-4) 0 0",
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              color: "var(--text-faint)",
              fontSize: "var(--t-2xs)",
              fontFamily: "var(--font-mono)",
              letterSpacing: ".16em",
              textTransform: "uppercase",
            }}
          >
            <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
            or share a link
            <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
          </div>
        </div>
      )}
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
