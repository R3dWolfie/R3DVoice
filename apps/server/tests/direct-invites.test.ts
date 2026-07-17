import { describe, it, expect, beforeEach, afterEach, afterAll } from "vitest";
import type { FastifyInstance } from "fastify";
import { makeTestApp } from "./helpers/app.js";
import { registerUser, authHeader, resetDb, type RegisteredUser } from "./helpers/fixtures.js";
import { disconnectDb } from "./helpers/db.js";
import { prisma } from "../src/db.js";

describe("directed room invites + notifications feed (4.15)", () => {
  let app: FastifyInstance;
  let alice: RegisteredUser;
  let bob: RegisteredUser;
  let roomId: string;

  beforeEach(async () => {
    await resetDb();
    app = await makeTestApp();
    alice = await registerUser(app, { email: "alice@test.local" });
    bob = await registerUser(app, { email: "bob@test.local" });
    const res = await app.inject({
      method: "POST",
      url: "/rooms",
      headers: authHeader(alice.token),
      payload: { name: "Studio Floor" },
    });
    roomId = res.json().id;
  });

  afterEach(async () => {
    if (app) await app.close();
  });
  afterAll(async () => {
    await disconnectDb();
  });

  it("owner can invite a user; invite shows in target's feed; accept grants membership", async () => {
    const inv = await app.inject({
      method: "POST",
      url: `/rooms/${roomId}/invite-user`,
      headers: authHeader(alice.token),
      payload: { userId: bob.id },
    });
    expect(inv.statusCode).toBe(201);
    const dto = inv.json().invite;
    expect(dto.room.name).toBe("Studio Floor");
    expect(dto.from.id).toBe(alice.id);

    const feed = await app.inject({
      method: "GET",
      url: "/notifications/feed",
      headers: authHeader(bob.token),
    });
    expect(feed.statusCode).toBe(200);
    expect(feed.json().invites).toHaveLength(1);
    expect(feed.json().invites[0].id).toBe(dto.id);

    const accept = await app.inject({
      method: "POST",
      url: `/invites/direct/${dto.id}/accept`,
      headers: authHeader(bob.token),
    });
    expect(accept.statusCode).toBe(200);
    expect(accept.json().roomId).toBe(roomId);
    const membership = await prisma.roomMembership.findUnique({
      where: { userId_roomId: { userId: bob.id, roomId } },
    });
    expect(membership).not.toBeNull();

    // Accepted invite leaves the feed.
    const feed2 = await app.inject({
      method: "GET",
      url: "/notifications/feed",
      headers: authHeader(bob.token),
    });
    expect(feed2.json().invites).toHaveLength(0);
  });

  it("decline removes the invite from the feed without membership", async () => {
    const inv = await app.inject({
      method: "POST",
      url: `/rooms/${roomId}/invite-user`,
      headers: authHeader(alice.token),
      payload: { userId: bob.id },
    });
    const id = inv.json().invite.id;
    const decline = await app.inject({
      method: "POST",
      url: `/invites/direct/${id}/decline`,
      headers: authHeader(bob.token),
    });
    expect(decline.statusCode).toBe(204);
    const membership = await prisma.roomMembership.findUnique({
      where: { userId_roomId: { userId: bob.id, roomId } },
    });
    expect(membership).toBeNull();
    // Second decline is rejected.
    const again = await app.inject({
      method: "POST",
      url: `/invites/direct/${id}/decline`,
      headers: authHeader(bob.token),
    });
    expect(again.statusCode).toBe(400);
  });

  it("re-inviting replaces the pending invite instead of stacking", async () => {
    for (let i = 0; i < 2; i++) {
      await app.inject({
        method: "POST",
        url: `/rooms/${roomId}/invite-user`,
        headers: authHeader(alice.token),
        payload: { userId: bob.id },
      });
    }
    const rows = await prisma.directInvite.findMany({
      where: { roomId, toUserId: bob.id, status: "pending" },
    });
    expect(rows).toHaveLength(1);
  });

  it("strangers cannot invite into a private room; self-invite rejected", async () => {
    const carol = await registerUser(app, { email: "carol@test.local" });
    const stranger = await app.inject({
      method: "POST",
      url: `/rooms/${roomId}/invite-user`,
      headers: authHeader(carol.token),
      payload: { userId: bob.id },
    });
    expect(stranger.statusCode).toBe(403);

    const self = await app.inject({
      method: "POST",
      url: `/rooms/${roomId}/invite-user`,
      headers: authHeader(alice.token),
      payload: { userId: alice.id },
    });
    expect(self.statusCode).toBe(400);
  });

  it("expired invites are excluded from the feed and cannot be accepted", async () => {
    const inv = await app.inject({
      method: "POST",
      url: `/rooms/${roomId}/invite-user`,
      headers: authHeader(alice.token),
      payload: { userId: bob.id },
    });
    const id = inv.json().invite.id;
    await prisma.directInvite.update({
      where: { id },
      data: { expiresAt: new Date(Date.now() - 1000) },
    });
    const feed = await app.inject({
      method: "GET",
      url: "/notifications/feed",
      headers: authHeader(bob.token),
    });
    expect(feed.json().invites).toHaveLength(0);
    const accept = await app.inject({
      method: "POST",
      url: `/invites/direct/${id}/accept`,
      headers: authHeader(bob.token),
    });
    expect(accept.statusCode).toBe(400);
  });

  it("feed carries mention history with room names; read-all moves the watermark", async () => {
    // Bob needs membership + a handle so @mention resolution hits.
    await prisma.roomMembership.create({ data: { userId: bob.id, roomId } });
    await prisma.user.update({
      where: { id: bob.id },
      data: { handle: "BobH", handleLower: "bobh" },
    });
    const send = await app.inject({
      method: "POST",
      url: "/chat/messages",
      headers: authHeader(alice.token),
      payload: { threadType: "room", threadId: roomId, body: "hey @BobH look at this" },
    });
    expect(send.statusCode).toBe(201);

    const feed = await app.inject({
      method: "GET",
      url: "/notifications/feed",
      headers: authHeader(bob.token),
    });
    expect(feed.statusCode).toBe(200);
    const { mentions, seenAt } = feed.json();
    expect(seenAt).toBeNull();
    expect(mentions).toHaveLength(1);
    expect(mentions[0].roomName).toBe("Studio Floor");
    expect(mentions[0].message.body).toContain("@BobH");

    const mark = await app.inject({
      method: "POST",
      url: "/notifications/read-all",
      headers: authHeader(bob.token),
    });
    expect(mark.statusCode).toBe(204);
    const feed2 = await app.inject({
      method: "GET",
      url: "/notifications/feed",
      headers: authHeader(bob.token),
    });
    expect(new Date(feed2.json().seenAt).getTime()).toBeGreaterThan(0);
    // History is retained — seenAt is a watermark, not a filter.
    expect(feed2.json().mentions).toHaveLength(1);
  });

  it("own messages never appear as mentions of self", async () => {
    await prisma.user.update({
      where: { id: alice.id },
      data: { handle: "AliceH", handleLower: "aliceh" },
    });
    await app.inject({
      method: "POST",
      url: "/chat/messages",
      headers: authHeader(alice.token),
      payload: { threadType: "room", threadId: roomId, body: "note to @AliceH self" },
    });
    const feed = await app.inject({
      method: "GET",
      url: "/notifications/feed",
      headers: authHeader(alice.token),
    });
    expect(feed.json().mentions).toHaveLength(0);
  });
});
