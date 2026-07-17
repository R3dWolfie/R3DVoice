import { describe, it, expect, vi } from "vitest";
import { routeNotification } from "../src/renderer/src/lib/notification-router";
import type { ChatMessageDTO, ChatWsEvent } from "@r3dvoice/shared";

function ctx(overrides: Partial<{ selfUserId: string; dndUntil: Date | null; muteLevel: "all" | "mentions" | "none" }> = {}) {
  const fire = vi.fn(async () => {});
  return {
    fire,
    arg: {
      selfUserId: overrides.selfUserId ?? "me",
      dndUntil: overrides.dndUntil ?? null,
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
