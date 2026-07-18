import type { ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { Avatar } from "./Avatar.js";

// A single "live · people talking now" row for the lobby activity feed (2.1
// `.feed-item.live`). Derived entirely from data the app already has: friends
// whose presence carries a `currentRoom`, plus owned/recent rooms reporting
// `inCall` occupancy. Green gradient + avatar stack + "live" tag per the deck.
export type LiveRoom = {
  roomId: string;
  name: string;
  /** Friends currently in this room (drives the avatar stack + handles). */
  friends: FriendDTO[];
  /** Occupancy count (room.inCall, floored to visible friends). */
  inCall: number;
};

function friendLabel(f: FriendDTO): string {
  return f.user.handle ? `@${f.user.handle}` : f.user.displayName;
}

export function LiveActivityRow({
  room,
  joining,
  onJoin,
}: {
  room: LiveRoom;
  joining: boolean;
  onJoin: () => void;
}): ReactElement {
  const shown = room.friends.slice(0, 3);
  const extra = Math.max(0, room.friends.length - shown.length);
  const names = shown.map(friendLabel);
  const talking =
    names.length > 0
      ? `${names.join(", ")}${extra > 0 ? ` +${extra}` : ""} ${room.friends.length === 1 ? "is" : "are"} talking`
      : `${room.inCall} in call`;

  return (
    <div
      style={{
        padding: "var(--s-3) var(--s-8)",
        display: "grid",
        gridTemplateColumns: "2.25rem 1fr auto",
        gap: "var(--s-4)",
        alignItems: "center",
        background: "linear-gradient(90deg, color-mix(in srgb, var(--ok) 10%, transparent), transparent 40%)",
      }}
    >
      <div
        aria-hidden
        style={{
          width: "2.25rem",
          height: "2.25rem",
          borderRadius: "var(--r-md)",
          background: "color-mix(in srgb, var(--ok) 12%, transparent)",
          border: "1px solid color-mix(in srgb, var(--ok) 40%, transparent)",
          display: "grid",
          placeItems: "center",
          color: "var(--ok)",
          fontFamily: "var(--font-mono)",
          fontWeight: 700,
        }}
      >
        ●
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
        <span style={{ fontSize: "var(--t-sm)", lineHeight: 1.4 }}>
          <b style={{ fontWeight: 600 }}>{room.name}</b>
          {" · "}
          <span style={{ color: "var(--text)" }}>{talking}</span>
        </span>
        <span
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            fontSize: "var(--t-xs)",
            color: "var(--text-dim)",
          }}
        >
          {shown.length > 0 && (
            <span style={{ display: "flex", flexShrink: 0 }}>
              {shown.map((f, i) => (
                <span
                  key={f.user.id}
                  style={{
                    marginLeft: i === 0 ? 0 : -5,
                    border: "2px solid var(--bg)",
                    borderRadius: "50%",
                    display: "inline-flex",
                  }}
                >
                  <Avatar
                    src={f.user.avatarUrl ?? null}
                    fallbackInitials={f.user.displayName}
                    fallbackColorSeed={f.user.id}
                    size={18}
                  />
                </span>
              ))}
            </span>
          )}
          <span>{room.inCall} in call</span>
          <span
            className="rv-mono"
            style={{
              color: "var(--ok)",
              fontWeight: 600,
              letterSpacing: ".12em",
              textTransform: "uppercase",
              fontSize: "var(--t-2xs)",
            }}
          >
            live
          </span>
        </span>
      </div>
      <div style={{ display: "flex", gap: "var(--s-2)" }}>
        <button
          className="rv-btn"
          data-variant="primary"
          disabled={joining}
          onClick={onJoin}
          style={{ height: "1.9rem", padding: "0 var(--s-4)", fontSize: "var(--t-xs)" }}
        >
          {joining ? <span className="rv-inline-spinner" aria-label="Joining" /> : "Join ›"}
        </button>
      </div>
    </div>
  );
}
