import { pushToast } from "../lib/toast-store.js";
import { prefsActions } from "../lib/prefs-singleton.js";

/**
 * Join/leave call feedback (UX audit #5). No notification sound assets are
 * bundled yet, so we surface a lightweight toast instead of a chime.
 *
 * Reusable + prefs-gated: honours the `joinLeaveToasts` toggle (Settings ›
 * Notifications). Safe to call from non-React code (LiveKit event handlers).
 *
 * WIRING: InRoomScreen (which owns the LiveKit room) must call this on the
 * room's ParticipantConnected / ParticipantDisconnected events, e.g.
 *   room.on(RoomEvent.ParticipantConnected, (p) =>
 *     notifyJoinLeave(p.name ?? p.identity, "joined"));
 *   room.on(RoomEvent.ParticipantDisconnected, (p) =>
 *     notifyJoinLeave(p.name ?? p.identity, "left"));
 * It is intentionally NOT wired here — this module owns only the helper + pref.
 */
export function notifyJoinLeave(name: string, event: "joined" | "left"): void {
  if (!prefsActions().joinLeaveToasts) return;
  const who = name.trim() || "Someone";
  pushToast({
    kind: "info",
    text: `${who} ${event === "joined" ? "joined the call" : "left the call"}`,
  });
}
