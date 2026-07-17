import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { Avatar } from "./Avatar.js";
import { I } from "./Icons.js";
import { InviteCreateModal } from "./InviteCreateModal.js";
import { MyInvitesList } from "./MyInvitesList.js";

type Props = {
  onJoinRoom?: (roomId: string) => void;
};

export function FriendsPane({ onJoinRoom }: Props = {}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const [addInput, setAddInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [inviteOpen, setInviteOpen] = useState(false);

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl); api.setToken(token); return api;
  }, [serverUrl, token]);

  const refresh = useCallback(async () => {
    try { const r = await apiFor().friends(); setFriends(r.friends); }
    catch (e) { setError(e instanceof Error ? e.message : "failed to load"); }
  }, [apiFor]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Live updates: refresh on friend.request, friend.accepted, presence.update.
  // Without this, you'd see an OS notification "@bob is now your friend"
  // but the friend list would stay stale until you reload the page.
  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    return t.on((event) => {
      if (
        event.type === "friend.request" ||
        event.type === "friend.accepted" ||
        event.type === "presence.update"
      ) {
        void refresh();
      }
    });
  }, [refresh]);

  const sendRequest = async (): Promise<void> => {
    const raw = addInput.trim();
    if (!raw) return;
    setBusy(true); setError(null);
    try {
      const looksLikeEmail = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(raw);
      if (looksLikeEmail) {
        await apiFor().friendRequest(raw);
      } else {
        await apiFor().friendRequestByHandle(raw.replace(/^@/, ""));
      }
      setAddInput("");
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to send");
    } finally { setBusy(false); }
  };

  const accept = async (id: string): Promise<void> => {
    try { await apiFor().friendAccept(id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "failed"); }
  };
  const reject = async (id: string): Promise<void> => {
    try { await apiFor().friendReject(id); await refresh(); }
    catch (e) { setError(e instanceof Error ? e.message : "failed"); }
  };

  const incoming = friends.filter((f) => f.status === "pending-incoming");
  const outgoing = friends.filter((f) => f.status === "pending-outgoing");
  const accepted = friends.filter((f) => f.status === "accepted");

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", padding: "var(--s-3) var(--s-4)" }}>
      <div>
        <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>Add a friend</div>
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <input
            className="rv-input"
            placeholder="@handle or email"
            value={addInput}
            onChange={(e) => setAddInput(e.target.value)}
            onKeyDown={(e) => { if (e.key === "Enter") { e.preventDefault(); void sendRequest(); } }}
            disabled={busy}
            style={{ flex: 1 }}
          />
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            onClick={() => void sendRequest()}
            disabled={busy || !addInput.trim()}
          >
            <I.Plus size={12} />
          </button>
        </div>
        <button
          type="button"
          className="rv-btn"
          data-variant="ghost"
          onClick={() => setInviteOpen(true)}
          style={{ marginTop: "var(--s-2)", width: "100%", fontSize: "var(--t-xs)" }}
        >
          Or generate an invite link
        </button>
        <InviteCreateModal open={inviteOpen} onClose={() => setInviteOpen(false)} />
      </div>

      {error && <div style={{ color: "var(--accent)", fontSize: "var(--t-sm)" }}>{error}</div>}

      {incoming.length > 0 && (
        <section>
          <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>Pending — incoming</div>
          {incoming.map((f) => (
            <div key={f.friendshipId} style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", padding: "var(--s-2) 0", fontSize: "var(--t-sm)" }}>
              <span style={{ flex: 1 }}>{f.user.displayName}</span>
              <button className="rv-btn" data-variant="primary" style={{ height: "1.7rem", fontSize: "var(--t-xs)" }} onClick={() => void accept(f.friendshipId)}>Accept</button>
              <button className="rv-btn" data-variant="ghost" style={{ height: "1.7rem", fontSize: "var(--t-xs)" }} onClick={() => void reject(f.friendshipId)}>Decline</button>
            </div>
          ))}
        </section>
      )}

      {accepted.length > 0 && (
        <section>
          <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>Friends ({accepted.length})</div>
          {accepted.map((f) => (
            <div key={f.friendshipId} style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", padding: "var(--s-2) 0", fontSize: "var(--t-sm)" }}>
              <Avatar
                src={f.user.avatarUrl ?? null}
                fallbackInitials={f.user.displayName}
                fallbackColorSeed={f.user.id}
                size={32}
              />
              <span style={{
                width: 8, height: 8, borderRadius: "50%",
                background: f.isOnline ? "var(--rv-live)" : "var(--text-faint)",
                flexShrink: 0,
              }} />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div>{f.user.displayName}{f.user.handle && <span style={{ color: "var(--text-faint)", fontSize: "var(--t-xs)" }}> @{f.user.handle}</span>}</div>
                {f.user.currentRoom && (
                  <button
                    type="button"
                    onClick={() => onJoinRoom?.(f.user.currentRoom!.id)}
                    style={{
                      background: "transparent", border: 0, padding: 0, cursor: "pointer",
                      color: "var(--accent)", fontSize: "var(--t-xs)", textDecoration: "underline",
                    }}
                  >
                    in {f.user.currentRoom.name} →
                  </button>
                )}
              </div>
            </div>
          ))}
        </section>
      )}

      {outgoing.length > 0 && (
        <section>
          <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>Pending — sent</div>
          {outgoing.map((f) => (
            <div key={f.friendshipId} style={{ display: "flex", alignItems: "center", gap: "var(--s-2)", padding: "var(--s-2) 0", fontSize: "var(--t-sm)" }}>
              <span style={{ flex: 1, color: "var(--text-faint)" }}>{f.user.displayName}</span>
              <button className="rv-btn" data-variant="ghost" style={{ height: "1.7rem", fontSize: "var(--t-xs)" }} onClick={() => void reject(f.friendshipId)}>Cancel</button>
            </div>
          ))}
        </section>
      )}

      <section>
        <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>My invites</div>
        <MyInvitesList />
      </section>
    </div>
  );
}
