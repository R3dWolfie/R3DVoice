import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { useAuthStore } from "../lib/auth-context.js";
import { useConnectionStore } from "../lib/connection-store.js";

/**
 * Presence depth (UX audit #4). The theme preview advertises idle + DND dots,
 * but the app only ever computed online/offline/in-voice. This module adds the
 * two missing states for the CURRENT user, entirely client-side:
 *
 *  - DND: real, from `user.dndUntil` (set via Settings/DndToggle).
 *  - Idle: a client-side inactivity timer (no OS/server signal needed).
 *
 * SERVER GAPS (noted, not fixed here):
 *  - FriendDTO carries `isOnline` + `currentRoom` but no `dndUntil` and no idle
 *    flag, so OTHER users' idle/DND can't be shown until the server includes
 *    them and propagates idle presence.
 *  - This local idle state is not pushed to the server, so peers won't see us
 *    as idle. Both need server work.
 *
 * The friend/me dots in FriendsPane + LeftIconColumn are owned by other agents;
 * they can adopt <PresenceDot> once the server feeds the data.
 */

/** Discord-style AFK window: no interaction for this long → idle. */
export const IDLE_AFTER_MS = 10 * 60 * 1000;

export type PresenceState = "online" | "idle" | "dnd" | "connecting" | "offline";

const PRESENCE_META: Record<PresenceState, { label: string; color: string }> = {
  online: { label: "Online", color: "var(--ok)" },
  idle: { label: "Idle", color: "var(--rv-amber)" },
  dnd: { label: "Do not disturb", color: "var(--danger)" },
  connecting: { label: "Connecting…", color: "var(--text-dim)" },
  offline: { label: "Offline", color: "var(--text-dim)" },
};

export function presenceMeta(state: PresenceState): { label: string; color: string } {
  return PRESENCE_META[state];
}

/**
 * Relative "last seen" for an offline friend's status line (WireFrames 2.2:
 * "offline · last seen 2h ago"). Falls back to a bare "offline" when the server
 * gives us no timestamp. Buckets: <1m → "just now", then minutes / hours / days,
 * else a short date.
 */
export function formatLastSeen(lastSeenAt: string | null | undefined): string {
  if (!lastSeenAt) return "offline";
  const then = new Date(lastSeenAt).getTime();
  if (Number.isNaN(then)) return "offline";
  const ms = Date.now() - then;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return "last seen just now";
  if (mins < 60) return `last seen ${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `last seen ${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `last seen ${days}d ago`;
  return `last seen ${new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" })}`;
}

/**
 * True after `thresholdMs` with no pointer/keyboard activity, or whenever the
 * window is hidden/minimized. Resets on any interaction.
 */
export function useIdle(thresholdMs: number = IDLE_AFTER_MS): boolean {
  const [idle, setIdle] = useState(false);
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const arm = (): void => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => setIdle(true), thresholdMs);
    };
    const bump = (): void => {
      if (document.visibilityState === "hidden") return;
      setIdle(false);
      arm();
    };
    const onVisibility = (): void => {
      if (document.visibilityState === "hidden") setIdle(true);
      else bump();
    };
    const events = ["pointerdown", "pointermove", "keydown", "wheel", "focus"];
    events.forEach((e) => window.addEventListener(e, bump, { passive: true }));
    document.addEventListener("visibilitychange", onVisibility);
    arm();
    return () => {
      if (timer) clearTimeout(timer);
      events.forEach((e) => window.removeEventListener(e, bump));
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [thresholdMs]);
  return idle;
}

/** Live presence for the signed-in user (DND > connecting > idle > online). */
export function usePresence(): { state: PresenceState; label: string; color: string } {
  const status = useAuthStore((s) => s.status);
  const dndUntil = useAuthStore((s) => s.user?.dndUntil ?? null);
  const conn = useConnectionStore((s) => s.status);
  const idle = useIdle();

  const dndActive = dndUntil !== null && new Date(dndUntil).getTime() > Date.now();
  let state: PresenceState;
  if (status !== "authenticated") state = "offline";
  else if (dndActive) state = "dnd";
  else if (conn === "connecting" || conn === "reconnecting") state = "connecting";
  else if (conn !== "open") state = "offline";
  else if (idle) state = "idle";
  else state = "online";

  const meta = PRESENCE_META[state];
  return { state, label: meta.label, color: meta.color };
}

/** Reusable presence dot. Offline renders hollow; the rest are filled + glow. */
export function PresenceDot({ state, size = 9 }: { state: PresenceState; size?: number }): ReactElement {
  const meta = PRESENCE_META[state];
  const base: CSSProperties = {
    width: size,
    height: size,
    borderRadius: "50%",
    flex: "none",
    display: "inline-block",
  };
  const style: CSSProperties =
    state === "offline"
      ? { ...base, background: "transparent", border: "1.5px solid var(--text-dim)" }
      : { ...base, background: meta.color, boxShadow: `0 0 6px color-mix(in srgb, ${meta.color} 60%, transparent)` };
  return <span role="img" aria-label={meta.label} title={meta.label} style={style} />;
}
