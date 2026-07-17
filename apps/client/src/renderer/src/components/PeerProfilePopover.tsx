import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { Avatar } from "./Avatar.js";

// Peer profile popover per WireFrames 2.4a: avatar + identity, live
// presence when they're a friend, and a Join-their-room shortcut.
export function PeerProfilePopover({
  peer,
  onClose,
  onJoinRoom,
}: {
  peer: { id: string; handle: string | null; displayName: string };
  onClose: () => void;
  onJoinRoom?: (roomId: string) => void;
}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [friend, setFriend] = useState<FriendDTO | null>(null);
  const [loaded, setLoaded] = useState(false);

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  }, [serverUrl, token]);

  useEffect(() => {
    let cancelled = false;
    apiFor()
      .friends()
      .then((r) => {
        if (cancelled) return;
        setFriend(r.friends.find((f) => f.user.id === peer.id) ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [apiFor, peer.id]);

  const accepted = friend?.status === "accepted";

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "transparent" }} />
      <div
        className="rv-menu rv-fade-in"
        style={{
          position: "absolute",
          top: "3rem",
          left: "var(--s-5)",
          width: 260,
          zIndex: 61,
          padding: "var(--s-4)",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <div style={{ position: "relative" }}>
            <Avatar
              src={friend?.user.avatarUrl ?? null}
              fallbackInitials={peer.displayName}
              fallbackColorSeed={peer.id}
              size={44}
            />
            {loaded && accepted && (
              <span
                className="rv-status"
                data-status={friend?.isOnline ? undefined : "offline"}
                style={{ position: "absolute", bottom: -1, right: -1, border: "2px solid var(--bg-elev)" }}
              />
            )}
          </div>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "var(--t-sm)" }}>{peer.displayName}</div>
            {peer.handle && (
              <div className="rv-mono" style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
                @{peer.handle}
              </div>
            )}
          </div>
        </div>

        <div style={{ marginTop: "var(--s-3)", fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
          {!loaded
            ? "…"
            : accepted
              ? friend?.user.currentRoom
                ? (
                    <>
                      in <b style={{ color: "var(--text)", fontWeight: 600 }}>{friend.user.currentRoom.name}</b>
                    </>
                  )
                : friend?.isOnline
                  ? "online"
                  : "offline"
              : friend
                ? "friend request pending"
                : "not in your friends yet"}
        </div>

        {accepted && friend?.user.currentRoom && onJoinRoom && (
          <button
            className="rv-btn"
            data-variant="primary"
            style={{ marginTop: "var(--s-3)", width: "100%", height: "1.9rem", fontSize: "var(--t-xs)" }}
            onClick={() => {
              onClose();
              onJoinRoom(friend.user.currentRoom!.id);
            }}
          >
            Join their room ›
          </button>
        )}
      </div>
    </>
  );
}
