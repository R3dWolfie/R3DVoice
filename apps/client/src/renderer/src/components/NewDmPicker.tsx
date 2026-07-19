import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { Modal } from "./Modal.js";
import { Avatar } from "./Avatar.js";
import { HandleMatchCard, useHandleMatch } from "./HandleMatchCard.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { dmThreadId } from "../lib/dm-thread-id.js";

type Peer = { id: string; handle: string | null; displayName: string };

type Props = {
  open: boolean;
  onClose(): void;
  /** Called once a peer is resolved. Caller routes to that thread. */
  onPick(threadId: string, peer: Peer): void;
};

// 4.1 new-DM picker: search box over the friend list (presence dots,
// offline dimmed) instead of a bare handle input. Pasting a @handle that
// isn't a friend still resolves via the live match card.
export function NewDmPicker({ open, onClose, onPick }: Props): ReactElement {
  const me = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [value, setValue] = useState("");
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const match = useHandleMatch(open ? value : "");

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    void api
      .friends()
      .then((r) => {
        if (!cancelled) setFriends(r.friends.filter((f) => f.status === "accepted"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open, serverUrl, token]);

  const pick = useCallback(
    (peer: Peer): void => {
      if (!me) return;
      onPick(dmThreadId(me.id, peer.id), peer);
      setValue("");
      setError(null);
      onClose();
    },
    [me, onPick, onClose],
  );

  const q = value.trim().replace(/^@/, "").toLowerCase();
  const shown = friends.filter(
    (f) =>
      !q ||
      f.user.displayName.toLowerCase().includes(q) ||
      (f.user.handle ?? "").toLowerCase().includes(q),
  );
  const matchIsNew = match !== null && !friends.some((f) => f.user.id === match.id);

  // Enter falls back to a direct handle lookup, so pasting a full @handle
  // works even before the debounced match lands.
  const submit = useCallback(async () => {
    if (!me) return;
    if (matchIsNew && match) return pick({ id: match.id, handle: match.handle ?? null, displayName: match.displayName });
    const first = shown[0];
    if (first) {
      return pick({ id: first.user.id, handle: first.user.handle ?? null, displayName: first.user.displayName });
    }
    const raw = value.trim().replace(/^@/, "");
    if (!raw) return;
    setBusy(true);
    setError(null);
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      const peer = await api.getUserByHandle(raw);
      pick(peer);
    } catch (e) {
      setError(e instanceof Error ? e.message : "user not found");
    } finally {
      setBusy(false);
    }
  }, [me, matchIsNew, match, shown, value, serverUrl, token, pick]);

  return (
    <Modal open={open} onClose={onClose} title="Start a conversation" width="min(92vw, 440px)">
      <div style={{ padding: "var(--s-5) var(--s-6)" }}>
      <input
        autoFocus
        className="rv-input"
        placeholder="Search friends or paste a @handle"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        disabled={busy}
        onKeyDown={(e) => {
          if (e.key === "Enter") void submit();
        }}
      />
      {error && <p style={{ color: "var(--danger)", marginTop: "var(--s-2)", fontSize: "var(--t-sm)" }}>{error}</p>}
      <div className="rv-scroll" style={{ marginTop: "var(--s-3)", maxHeight: 300, overflowY: "auto" }}>
        {shown.length === 0 && !matchIsNew ? (
          <div style={{ padding: "var(--s-4) var(--s-2)", color: "var(--text-faint)", fontSize: "var(--t-sm)" }}>
            {friends.length === 0
              ? "No friends yet - paste a @handle to start a conversation."
              : "No friends match - paste a full @handle to look them up."}
          </div>
        ) : (
          <div className="rv-list">
            {shown.map((f) => (
              <div
                key={f.user.id}
                className="rv-list-item"
                data-offline={f.isOnline ? undefined : "true"}
                style={{ opacity: f.isOnline ? 1 : 0.6 }}
                onClick={() =>
                  pick({ id: f.user.id, handle: f.user.handle ?? null, displayName: f.user.displayName })
                }
              >
                <div style={{ position: "relative" }}>
                  <Avatar
                    src={f.user.avatarUrl ?? null}
                    fallbackInitials={f.user.displayName}
                    fallbackColorSeed={f.user.id}
                    size={32}
                  />
                  <span
                    className="rv-status"
                    data-status={f.isOnline ? undefined : "offline"}
                    style={{ position: "absolute", bottom: -1, right: -1, boxShadow: "0 0 0 2px var(--bg-elev)" }}
                  />
                </div>
                <span style={{ display: "flex", gap: 6, alignItems: "baseline", minWidth: 0 }}>
                  <span
                    style={{
                      fontSize: "var(--t-sm)",
                      fontWeight: 500,
                      overflow: "hidden",
                      textOverflow: "ellipsis",
                      whiteSpace: "nowrap",
                    }}
                  >
                    {f.user.displayName}
                  </span>
                  {f.user.handle && (
                    <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                      @{f.user.handle}
                    </span>
                  )}
                </span>
                <span />
              </div>
            ))}
          </div>
        )}
        {matchIsNew && match && (
          <div style={{ marginTop: shown.length > 0 ? "var(--s-2)" : 0 }}>
            <div className="rv-label" style={{ fontSize: "var(--t-2xs)", marginBottom: "var(--s-1)" }}>
              Not a friend yet
            </div>
            <HandleMatchCard
              match={match}
              onClick={() => pick({ id: match.id, handle: match.handle ?? null, displayName: match.displayName })}
            />
          </div>
        )}
      </div>
      </div>
    </Modal>
  );
}
