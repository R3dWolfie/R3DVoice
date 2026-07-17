import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { useUnreadStore } from "../lib/unread-store.js";
import { Avatar } from "./Avatar.js";

// Bell panel per WireFrames 4.15, scoped to what the server can feed today:
// pending friend requests (with actions) and unread DMs. Mentions history
// and directed room invites need backend work (phase 6) before their rows
// can be honest.
export function NotificationsPanel({
  open,
  onClose,
  onOpenDms,
  onOpenFriends,
}: {
  open: boolean;
  onClose: () => void;
  onOpenDms: () => void;
  onOpenFriends: () => void;
}): ReactElement | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const counts = useUnreadStore((s) => s.counts);
  const totalUnread = useUnreadStore((s) => s.totalUnread);
  const [incoming, setIncoming] = useState<FriendDTO[]>([]);

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  }, [serverUrl, token]);

  const refresh = useCallback(async () => {
    try {
      const r = await apiFor().friends();
      setIncoming(r.friends.filter((f) => f.status === "pending-incoming"));
    } catch {
      /* panel is passive — leave stale on error */
    }
  }, [apiFor]);

  useEffect(() => {
    if (open) void refresh();
  }, [open, refresh]);

  useEffect(() => {
    const t = getTransport();
    if (!t) return;
    return t.on((event) => {
      if (event.type === "friend.request" || event.type === "friend.accepted") void refresh();
    });
  }, [refresh]);

  if (!open) return null;

  const dmThreads = Object.entries(counts).filter(([key, n]) => key.startsWith("dm:") && n > 0);

  const act = async (id: string, kind: "accept" | "reject"): Promise<void> => {
    try {
      if (kind === "accept") await apiFor().friendAccept(id);
      else await apiFor().friendReject(id);
      await refresh();
    } catch {
      /* refresh next open */
    }
  };

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60, background: "transparent" }} />
      <div
        className="rv-fade-in"
        style={{
          position: "absolute",
          left: "100%",
          top: 0,
          marginLeft: 8,
          width: 320,
          maxHeight: 420,
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-md)",
          boxShadow: "var(--shadow-2)",
          zIndex: 61,
          display: "flex",
          flexDirection: "column",
          overflow: "hidden",
        }}
      >
        <div
          style={{
            padding: "var(--s-3) var(--s-4)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex",
            alignItems: "baseline",
            gap: "var(--s-2)",
          }}
        >
          <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>Notifications</span>
          <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
            {incoming.length + totalUnread || "none"} {incoming.length + totalUnread > 0 ? "waiting" : ""}
          </span>
        </div>

        <div className="rv-scroll" style={{ overflow: "auto", minHeight: 0, padding: "var(--s-2)" }}>
          {incoming.length === 0 && dmThreads.length === 0 && (
            <div className="rv-empty" style={{ padding: "var(--s-6) var(--s-4)" }}>
              <span className="rv-empty-title">All caught up</span>
              <span className="rv-empty-hint">Friend requests and unread DMs land here.</span>
            </div>
          )}

          {incoming.map((f) => (
            <div
              key={f.friendshipId}
              style={{
                display: "flex",
                gap: "var(--s-3)",
                padding: "var(--s-3)",
                borderRadius: "var(--r-sm)",
                background: "var(--accent-tint)",
                marginBottom: "var(--s-2)",
                alignItems: "flex-start",
              }}
            >
              <Avatar
                src={f.user.avatarUrl ?? null}
                fallbackInitials={f.user.displayName}
                fallbackColorSeed={f.user.id}
                size={32}
              />
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: "var(--t-xs)", lineHeight: 1.45 }}>
                  <b style={{ fontWeight: 600 }}>{f.user.displayName}</b>
                  {f.user.handle && <span style={{ color: "var(--text-dim)" }}> @{f.user.handle}</span>} sent you a
                  friend request.
                </div>
                <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-2)" }}>
                  <button
                    className="rv-btn"
                    data-variant="primary"
                    style={{ height: "1.6rem", fontSize: "var(--t-2xs)", padding: "0 var(--s-3)" }}
                    onClick={() => void act(f.friendshipId, "accept")}
                  >
                    Accept
                  </button>
                  <button
                    className="rv-btn"
                    style={{ height: "1.6rem", fontSize: "var(--t-2xs)", padding: "0 var(--s-3)" }}
                    onClick={() => void act(f.friendshipId, "reject")}
                  >
                    Decline
                  </button>
                </div>
              </div>
            </div>
          ))}

          {dmThreads.map(([key, n]) => (
            <button
              key={key}
              type="button"
              className="rv-menu-item"
              style={{ width: "100%" }}
              onClick={() => {
                onClose();
                onOpenDms();
              }}
            >
              <span style={{ width: 16, textAlign: "center", color: "var(--text-dim)" }}>✉</span>
              <span style={{ flex: 1 }}>
                {n} unread {n === 1 ? "message" : "messages"}
              </span>
            </button>
          ))}
        </div>

        <div
          style={{
            padding: "var(--s-2) var(--s-3)",
            borderTop: "1px solid var(--border-soft)",
            display: "flex",
            justifyContent: "space-between",
          }}
        >
          <button
            type="button"
            className="rv-btn"
            data-variant="ghost"
            style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
            onClick={() => {
              onClose();
              onOpenFriends();
            }}
          >
            Friends page
          </button>
          <button
            type="button"
            className="rv-btn"
            data-variant="ghost"
            style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
            onClick={() => {
              onClose();
              onOpenDms();
            }}
          >
            Open DMs
          </button>
        </div>
      </div>
    </>
  );
}
