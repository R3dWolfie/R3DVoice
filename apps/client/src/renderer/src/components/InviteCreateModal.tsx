import { useCallback, useEffect, useState, type ReactElement } from "react";
import { Modal } from "./Modal.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { Avatar } from "./Avatar.js";
import { PresenceDot, type PresenceState } from "./presence.js";
import { pushToast } from "../lib/toast-store.js";
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

function relativeAge(iso: string | null | undefined): string {
  if (!iso) return "recently";
  const ms = Date.now() - new Date(iso).getTime();
  const m = Math.floor(ms / 60_000);
  if (m < 1) return "just now";
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  return `${Math.floor(h / 24)}d ago`;
}

// The server only distinguishes online/dnd/offline for friends (idle needs
// client self-reporting, see presence.tsx). Fall back to isOnline on older
// servers that omit presenceState.
function friendPresence(f: FriendDTO): PresenceState {
  if (f.presenceState === "dnd") return "dnd";
  if (f.presenceState === "online") return "online";
  if (f.presenceState === "offline") return "offline";
  return f.isOnline ? "online" : "offline";
}

// Per-friend activity line (4.16). currentRoom is the strongest "in voice"
// signal; otherwise fall back to coarse presence + last-seen.
function activityLine(f: FriendDTO, roomId: string | undefined): { text: string; color: string } {
  const cr = f.user.currentRoom;
  if (cr) {
    return cr.id === roomId
      ? { text: "in this room now", color: "var(--ok)" }
      : { text: `in another room · ${cr.name}`, color: "var(--ok)" };
  }
  const p = friendPresence(f);
  if (p === "online") return { text: "online", color: "var(--ok)" };
  if (p === "dnd") return { text: "do not disturb", color: "var(--danger)" };
  return {
    text: f.lastSeenAt ? `offline · last seen ${relativeAge(f.lastSeenAt)}` : "offline",
    color: "var(--text-dim)",
  };
}

// 4.16: friends "recently in voice" - currently in a room, or online (the best
// available proxy for recent voice activity client-side).
function recentlyInVoice(f: FriendDTO): boolean {
  return f.user.currentRoom != null || friendPresence(f) === "online";
}

export function InviteCreateModal({ open, onClose, roomId }: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [oneTime, setOneTime] = useState(false);
  const [expiryMs, setExpiryMs] = useState<number | null>(EXPIRY_OPTIONS[2]!.ms); // 7 days default
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [code, setCode] = useState<string | null>(null);
  const [search, setSearch] = useState("");
  // 4.16 invite-friends: directed person-to-person invites (bell Invites tab),
  // alongside the always-visible shareable link footer. Room invites only.
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

  const close = useCallback(() => {
    setCode(null);
    setError(null);
    setSearch("");
    onClose();
  }, [onClose]);

  const base = serverUrl.replace(/\/$/, "");
  // Always-visible share link (deck 4.16 footer): default to the room join
  // link so it's copyable from the start; swap to the custom invite link once
  // one has been generated.
  const shareUrl = code ? `${base}/invite/${code}` : roomId ? `${base}/join/${roomId}` : null;

  const copyShare = async (): Promise<void> => {
    if (!shareUrl) return;
    try {
      await navigator.clipboard.writeText(shareUrl);
      pushToast({ kind: "success", text: "Invite link copied", sub: shareUrl });
    } catch {
      pushToast({ kind: "error", text: "Couldn't access the clipboard" });
    }
  };

  const q = search.trim().toLowerCase();
  const matchesSearch = (f: FriendDTO): boolean =>
    !q || f.user.displayName.toLowerCase().includes(q) || (f.user.handle ?? "").toLowerCase().includes(q);
  const visible = friends.filter(matchesSearch);
  const recent = visible.filter(recentlyInVoice);
  const others = visible.filter((f) => !recentlyInVoice(f));

  const groupLabel = (label: string, count: number, pip = false): ReactElement => (
    <div
      className="rv-mono"
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-2)",
        padding: "var(--s-3) var(--s-6) var(--s-1)",
        fontSize: "var(--t-2xs)",
        letterSpacing: ".12em",
        textTransform: "uppercase",
        color: "var(--text-faint)",
      }}
    >
      {pip && (
        <span aria-hidden style={{ width: 6, height: 6, borderRadius: "50%", background: "var(--ok)", flexShrink: 0 }} />
      )}
      {label} · {count}
    </div>
  );

  const friendRow = (f: FriendDTO): ReactElement => {
    const act = activityLine(f, roomId);
    const state = invited[f.user.id];
    return (
      <div
        key={f.user.id}
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          padding: "var(--s-2) var(--s-6)",
        }}
      >
        <span style={{ position: "relative", display: "inline-flex", flexShrink: 0 }}>
          <Avatar src={f.user.avatarUrl ?? null} fallbackInitials={f.user.displayName} fallbackColorSeed={f.user.id} size={32} />
          <span style={{ position: "absolute", bottom: -1, right: -1, border: "2px solid var(--bg-elev)", borderRadius: "50%", display: "inline-flex" }}>
            <PresenceDot state={friendPresence(f)} size={9} />
          </span>
        </span>
        <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: 1 }}>
          <div style={{ fontSize: "var(--t-sm)", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {f.user.displayName}
          </div>
          {f.user.handle && (
            <div className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
              @{f.user.handle}
            </div>
          )}
          <div style={{ fontSize: "var(--t-2xs)", color: act.color }}>{act.text}</div>
        </div>
        <button
          className="rv-btn"
          data-variant={state === "sent" ? undefined : "primary"}
          disabled={state === "sent"}
          style={{ height: "1.7rem", fontSize: "var(--t-2xs)", padding: "0 var(--s-3)", flexShrink: 0 }}
          onClick={() => void inviteFriend(f.user.id)}
        >
          {state === "sent" ? "Invited ✓" : state === "error" ? "Retry" : "＋ Send"}
        </button>
      </div>
    );
  };

  return (
    <Modal
      open={open}
      onClose={close}
      icon="＋"
      title={roomId ? "Invite to this room" : "Invite a friend"}
      subtitle={roomId ? "Send a tap-to-join card, or share the link below." : "Share a friend-request link."}
      width="min(94vw, 480px)"
      footer={
        <>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", flex: 1, minWidth: 0 }}>
            <span
              aria-hidden
              style={{
                width: "1.75rem",
                height: "1.75rem",
                borderRadius: "var(--r-md)",
                background: "var(--bg-elev)",
                border: "1px solid var(--border)",
                display: "grid",
                placeItems: "center",
                fontSize: "var(--t-sm)",
                color: "var(--text-mid)",
                flexShrink: 0,
              }}
            >
              ⧉
            </span>
            <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
              <span style={{ fontSize: "var(--t-xs)", fontWeight: 500 }}>
                {code ? "Custom invite link" : "Or share a link"}
              </span>
              <span
                className="rv-mono"
                style={{
                  fontSize: "var(--t-2xs)",
                  color: "var(--text-dim)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {shareUrl ?? "Generate a link to share →"}
              </span>
            </div>
          </div>
          <button
            className="rv-btn"
            onClick={() => void copyShare()}
            disabled={!shareUrl}
            style={{ flexShrink: 0 }}
          >
            Copy link
          </button>
        </>
      }
    >
      {roomId && (
        <div style={{ padding: "var(--s-4) var(--s-6) 0" }}>
          <input
            className="rv-input"
            placeholder="Filter friends by name or @handle…"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            style={{ height: "2.25rem", fontSize: "var(--t-sm)" }}
          />
        </div>
      )}

      {roomId && friends.length > 0 && (
        <div style={{ paddingBottom: "var(--s-2)" }}>
          {recent.length > 0 && (
            <>
              {groupLabel("Recently in voice", recent.length, true)}
              {recent.map(friendRow)}
            </>
          )}
          {others.length > 0 && (
            <>
              {groupLabel("All friends", others.length)}
              {others.map(friendRow)}
            </>
          )}
          {recent.length === 0 && others.length === 0 && (
            <div className="rv-empty" style={{ padding: "var(--s-6) var(--s-6)" }}>
              <span className="rv-empty-title">No friends match “{search.trim()}”</span>
            </div>
          )}
        </div>
      )}

      {/* Custom expiring link controls (kept from the original generate flow). */}
      <div
        style={{
          padding: "var(--s-4) var(--s-6)",
          borderTop: roomId && friends.length > 0 ? "1px solid var(--border-soft)" : "none",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
        }}
      >
        <span
          className="rv-mono"
          style={{ fontSize: "var(--t-2xs)", letterSpacing: ".12em", textTransform: "uppercase", color: "var(--text-faint)" }}
        >
          Custom link options
        </span>
        <label style={{ display: "block" }}>
          <span style={{ display: "block", fontSize: "var(--t-xs)", color: "var(--text-mid)", marginBottom: "var(--s-1)" }}>Expires</span>
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
        <label style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
          <input type="checkbox" checked={oneTime} onChange={(e) => setOneTime(e.target.checked)} />
          <span style={{ fontSize: "var(--t-sm)" }}>One-time use</span>
        </label>
        {error && <p style={{ color: "var(--danger)", fontSize: "var(--t-xs)", margin: 0 }}>{error}</p>}
        <button
          className="rv-btn"
          data-variant="primary"
          disabled={busy}
          onClick={() => void generate()}
          style={{ width: "100%" }}
        >
          {busy ? "generating…" : code ? "Regenerate link" : "Generate link"}
        </button>
      </div>
    </Modal>
  );
}
