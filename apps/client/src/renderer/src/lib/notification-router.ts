import type { ChatWsEvent, MuteLevel } from "@r3dvoice/shared";

type RouteContext = {
  /** Caller's userId - used to suppress self-mentions and self-events. */
  selfUserId: string;
  /** Current DND state - null means not in DND. */
  dndUntil: Date | null;
  /** Notification prefs (Settings › Notifications, 3.7). */
  prefs: {
    /** OS banner for every DM message. Off = DMs only surface as unread counts. */
    dmBanners: boolean;
    /** Include message text in DM banners. Off = generic text (screenshare-safe). */
    dmPreviews: boolean;
    /**
     * Quiet hours window ("HH:MM" local, 24h) - present only when enabled.
     * Deck 3.7: "Suppress all banners + sounds during quiet hours" - so this
     * silences EVERYTHING, including friend requests (unlike DND). Mentions
     * still land in the bell panel; only the popup is suppressed.
     */
    quietHours?: { start: string; end: string } | undefined;
  };
  /** Mute lookup for any (threadType, threadId). Returns "all" when no row. */
  getMuteLevel(threadType: "room" | "dm", threadId: string): Promise<MuteLevel>;
  /** Cross to main process. */
  fireOSNotification(payload: { title: string; body: string }): Promise<void>;
};

/**
 * True when `now` falls inside the [start, end) local-time window.
 * Handles overnight wraps (22:00 → 08:00). start === end ⇒ never active
 * (a zero-length window, not a 24h one - matches the time inputs' intent).
 */
export function isInQuietHours(now: Date, start: string, end: string): boolean {
  const parse = (s: string): number | null => {
    const m = /^(\d{1,2}):(\d{2})$/.exec(s.trim());
    if (!m) return null;
    const h = Number(m[1]);
    const min = Number(m[2]);
    if (h > 23 || min > 59) return null;
    return h * 60 + min;
  };
  const a = parse(start);
  const b = parse(end);
  if (a === null || b === null || a === b) return false;
  const t = now.getHours() * 60 + now.getMinutes();
  return a < b ? t >= a && t < b : t >= a || t < b;
}

/**
 * Decide whether a WS event should fire an OS notification, and fire it.
 */
export async function routeNotification(event: ChatWsEvent, ctx: RouteContext): Promise<void> {
  // Quiet hours gate - ahead of everything, friend requests included (3.7).
  const qh = ctx.prefs.quietHours;
  if (qh && isInQuietHours(new Date(), qh.start, qh.end)) return;

  const dndActive = ctx.dndUntil !== null && ctx.dndUntil.getTime() > Date.now();

  switch (event.type) {
    case "chat.mention": {
      if (event.message.authorId === ctx.selfUserId) return;
      const lvl = await ctx.getMuteLevel(event.message.threadType, event.message.threadId);
      if (lvl === "none") return;
      if (dndActive) return;
      const isDm = event.message.threadType === "dm";
      void ctx.fireOSNotification({
        title: `@${event.message.authorName} mentioned you`,
        body: isDm && !ctx.prefs.dmPreviews ? "New message" : (event.message.body ?? "(empty)"),
      });
      return;
    }
    case "message": {
      if (event.message.authorId === ctx.selfUserId) return;
      const isDm = event.message.threadType === "dm";
      if (isDm && !ctx.prefs.dmBanners) return;
      const lvl = await ctx.getMuteLevel(event.message.threadType, event.message.threadId);
      if (lvl === "none") return;
      if (lvl === "mentions") return; // chat.mention handles the mention case separately
      if (dndActive) return;
      void ctx.fireOSNotification({
        title: event.message.authorName,
        body: isDm && !ctx.prefs.dmPreviews ? "New message" : (event.message.body ?? "(empty)"),
      });
      return;
    }
    case "friend.request": {
      // friend.request bypasses DND per spec - rare and important.
      void ctx.fireOSNotification({
        title: "New friend request",
        body: `from @${event.from.handle ?? event.from.displayName}`,
      });
      return;
    }
    case "friend.accepted": {
      if (dndActive) return;
      void ctx.fireOSNotification({
        title: "Friend request accepted",
        body: `@${event.by.handle ?? event.by.displayName} is now your friend`,
      });
      return;
    }
    case "invite.redeemed": {
      if (dndActive) return;
      void ctx.fireOSNotification({
        title: "Invite redeemed",
        body: `@${event.by.handle ?? event.by.displayName} used your invite`,
      });
      return;
    }
    default:
      return;
  }
}
