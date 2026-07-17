import type { ChatWsEvent, MuteLevel } from "@r3dvoice/shared";

type RouteContext = {
  /** Caller's userId — used to suppress self-mentions and self-events. */
  selfUserId: string;
  /** Current DND state — null means not in DND. */
  dndUntil: Date | null;
  /** Notification prefs (Settings › Notifications, 3.7). */
  prefs: {
    /** OS banner for every DM message. Off = DMs only surface as unread counts. */
    dmBanners: boolean;
    /** Include message text in DM banners. Off = generic text (screenshare-safe). */
    dmPreviews: boolean;
  };
  /** Mute lookup for any (threadType, threadId). Returns "all" when no row. */
  getMuteLevel(threadType: "room" | "dm", threadId: string): Promise<MuteLevel>;
  /** Cross to main process. */
  fireOSNotification(payload: { title: string; body: string }): Promise<void>;
};

/**
 * Decide whether a WS event should fire an OS notification, and fire it.
 */
export async function routeNotification(event: ChatWsEvent, ctx: RouteContext): Promise<void> {
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
      // friend.request bypasses DND per spec — rare and important.
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
