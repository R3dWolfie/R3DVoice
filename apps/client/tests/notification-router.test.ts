import { describe, it, expect, vi } from "vitest";
import { isInQuietHours, routeNotification } from "../src/renderer/src/lib/notification-router";
import type { ChatMessageDTO, ChatWsEvent } from "@r3dvoice/shared";

function ctx(
  overrides: Partial<{
    selfUserId: string;
    dndUntil: Date | null;
    muteLevel: "all" | "mentions" | "none";
    dmBanners: boolean;
    dmPreviews: boolean;
  }> = {},
) {
  const fire = vi.fn(async () => {});
  return {
    fire,
    arg: {
      selfUserId: overrides.selfUserId ?? "me",
      dndUntil: overrides.dndUntil ?? null,
      prefs: {
        dmBanners: overrides.dmBanners ?? true,
        dmPreviews: overrides.dmPreviews ?? true,
      },
      getMuteLevel: async () => (overrides.muteLevel ?? "all") as "all" | "mentions" | "none",
      fireOSNotification: fire,
    },
  };
}

function makeMessage(overrides: Partial<{ authorId: string; threadType: "room" | "dm"; threadId: string }> = {}): ChatMessageDTO {
  return {
    id: "m1",
    threadType: overrides.threadType ?? "dm",
    threadId: overrides.threadId ?? "a:b",
    authorId: overrides.authorId ?? "other",
    authorName: "Other",
    body: "hi",
    createdAt: "2026-04-30T00:00:00Z",
    editedAt: null,
    deletedAt: null,
  };
}

const msg = (overrides: Partial<{ authorId: string; threadType: "room" | "dm"; threadId: string }> = {}): ChatWsEvent => ({
  type: "message",
  message: makeMessage(overrides),
});

describe("notification-router", () => {
  it("fires for plain message when level=all and not in DND", async () => {
    const c = ctx();
    await routeNotification(msg(), c.arg);
    expect(c.fire).toHaveBeenCalledTimes(1);
  });

  it("does not fire for plain message when level=mentions", async () => {
    const c = ctx({ muteLevel: "mentions" });
    await routeNotification(msg(), c.arg);
    expect(c.fire).not.toHaveBeenCalled();
  });

  it("does not fire for plain message when level=none", async () => {
    const c = ctx({ muteLevel: "none" });
    await routeNotification(msg(), c.arg);
    expect(c.fire).not.toHaveBeenCalled();
  });

  it("does not fire for self-authored", async () => {
    const c = ctx();
    await routeNotification(msg({ authorId: "me" }), c.arg);
    expect(c.fire).not.toHaveBeenCalled();
  });

  it("does not fire for plain message when DND is active", async () => {
    const c = ctx({ dndUntil: new Date(Date.now() + 60_000) });
    await routeNotification(msg(), c.arg);
    expect(c.fire).not.toHaveBeenCalled();
  });

  it("friend.request fires even in DND", async () => {
    const c = ctx({ dndUntil: new Date(Date.now() + 60_000) });
    await routeNotification({ type: "friend.request", from: { id: "x", handle: "x", displayName: "X" } }, c.arg);
    expect(c.fire).toHaveBeenCalledTimes(1);
  });

  it("chat.mention fires when level=mentions", async () => {
    const c = ctx({ muteLevel: "mentions" });
    await routeNotification({
      type: "chat.mention",
      message: makeMessage(),
    } as ChatWsEvent, c.arg);
    expect(c.fire).toHaveBeenCalledTimes(1);
  });
});

describe("quiet hours (3.7)", () => {
  const at = (h: number, m = 0): Date => new Date(2026, 6, 17, h, m, 0);

  it("same-day window: inside / outside / boundary", () => {
    expect(isInQuietHours(at(10), "09:00", "17:00")).toBe(true);
    expect(isInQuietHours(at(8, 59), "09:00", "17:00")).toBe(false);
    expect(isInQuietHours(at(9, 0), "09:00", "17:00")).toBe(true); // start inclusive
    expect(isInQuietHours(at(17, 0), "09:00", "17:00")).toBe(false); // end exclusive
  });

  it("overnight wrap: 22:00 → 08:00", () => {
    expect(isInQuietHours(at(23), "22:00", "08:00")).toBe(true);
    expect(isInQuietHours(at(3), "22:00", "08:00")).toBe(true);
    expect(isInQuietHours(at(12), "22:00", "08:00")).toBe(false);
  });

  it("degenerate inputs never activate", () => {
    expect(isInQuietHours(at(12), "12:00", "12:00")).toBe(false);
    expect(isInQuietHours(at(12), "garbage", "13:00")).toBe(false);
    expect(isInQuietHours(at(12), "25:00", "13:00")).toBe(false);
  });

  it("suppresses everything while active — friend.request included", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 17, 23, 30));
    try {
      const c = ctx();
      const arg = { ...c.arg, prefs: { ...c.arg.prefs, quietHours: { start: "22:00", end: "08:00" } } };
      await routeNotification(msg(), arg);
      await routeNotification({ type: "friend.request", from: { id: "x", handle: "x", displayName: "X" } }, arg);
      expect(c.fire).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
    }
  });

  it("does not suppress when the window is inactive", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(2026, 6, 17, 12, 0));
    try {
      const c = ctx();
      const arg = { ...c.arg, prefs: { ...c.arg.prefs, quietHours: { start: "22:00", end: "08:00" } } };
      await routeNotification(msg(), arg);
      expect(c.fire).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
