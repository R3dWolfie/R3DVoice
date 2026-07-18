import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { isUserOnline, sendToUser } from "../chat/ws-state.js";
import { userHandleSchema } from "@r3dvoice/shared";

// Canonicalize (trim + lowercase) so the lookup matches the canonical email
// now stored at registration — mirrors the handleLower / emailSchema convention.
const sendBodySchema = z.object({ email: z.string().trim().email().toLowerCase() });
const respondParamsSchema = z.object({ id: z.string().min(1) });

interface FriendDTO {
  friendshipId: string;
  status: "pending-incoming" | "pending-outgoing" | "accepted" | "blocked";
  user: { id: string; displayName: string; email: string; handle: string | null; currentRoom: { id: string; name: string } | null };
  isOnline: boolean;
  // Coarse presence for the list (2.2): "online" | "dnd" | "offline". Derived
  // from the live socket set + dndUntil; "offline" when they have no socket.
  presenceState: "online" | "dnd" | "offline";
  // ISO timestamp of when they were last online, or null if never recorded.
  lastSeenAt: string | null;
  requestedAt: string;
  respondedAt: string | null;
}

export async function friendsRoutes(app: FastifyInstance): Promise<void> {
  app.get(
    "/friends",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const rows = await prisma.friendship.findMany({
        where: {
          OR: [{ requesterId: userId }, { recipientId: userId }],
        },
        include: {
          requester: {
            select: {
              id: true,
              displayName: true,
              email: true,
              handle: true,
              dndUntil: true,
              lastSeenAt: true,
              currentRoom: { select: { id: true, name: true } },
            },
          },
          recipient: {
            select: {
              id: true,
              displayName: true,
              email: true,
              handle: true,
              dndUntil: true,
              lastSeenAt: true,
              currentRoom: { select: { id: true, name: true } },
            },
          },
        },
        orderBy: { requestedAt: "desc" },
      });
      // The blocked party must not learn they're blocked: rows where someone
      // else blocked me (I'm the recipient of a blocked row) are invisible.
      const visible = rows.filter((f) => !(f.status === "blocked" && f.recipientId === userId));
      const friends: FriendDTO[] = visible.map((f) => {
        const isRequester = f.requesterId === userId;
        const other = isRequester ? f.recipient : f.requester;
        let status: FriendDTO["status"];
        if (f.status === "pending") {
          status = isRequester ? "pending-outgoing" : "pending-incoming";
        } else if (f.status === "blocked") {
          status = "blocked";
        } else {
          status = "accepted";
        }
        const online = isUserOnline(other.id);
        // dnd only applies while they're online AND their DND window is still
        // in the future; otherwise online → "online", no socket → "offline".
        const inDnd = other.dndUntil != null && other.dndUntil.getTime() > Date.now();
        const presenceState: FriendDTO["presenceState"] = online
          ? inDnd
            ? "dnd"
            : "online"
          : "offline";
        return {
          friendshipId: f.id,
          status,
          user: {
            id: other.id,
            displayName: other.displayName,
            email: other.email,
            handle: other.handle ?? null,
            currentRoom: other.currentRoom ?? null,
          },
          isOnline: online,
          presenceState,
          lastSeenAt: other.lastSeenAt?.toISOString() ?? null,
          requestedAt: f.requestedAt.toISOString(),
          respondedAt: f.respondedAt?.toISOString() ?? null,
        };
      });
      return { friends };
    },
  );

  // Send a friend request by email. Server reveals existence/non-existence of
  // the email — acceptable on an invite-only self-hosted instance. For a
  // public deployment, swap this for a friend-code mechanism.
  app.post(
    "/friends/request",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const parsed = sendBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid email");
      const userId = request.auth!.userId;
      const recipient = await prisma.user.findUnique({
        where: { email: parsed.data.email },
        select: { id: true, displayName: true, email: true },
      });
      if (!recipient) throw new NotFoundError("no user with that email");
      if (recipient.id === userId) throw new ValidationError("cannot friend yourself");

      // Reject if there's already any friendship row in either direction.
      const existing = await prisma.friendship.findFirst({
        where: {
          OR: [
            { requesterId: userId, recipientId: recipient.id },
            { requesterId: recipient.id, recipientId: userId },
          ],
        },
      });
      if (existing) {
        if (existing.status === "blocked") throw new ConflictError("blocked");
        if (existing.status === "accepted") throw new ConflictError("already friends");
        if (existing.status === "pending") throw new ConflictError("request already pending");
      }

      let row;
      try {
        row = await prisma.friendship.create({
          data: {
            requesterId: userId,
            recipientId: recipient.id,
            status: "pending",
          },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("request already pending");
        }
        throw err;
      }
      // Fetch requester identity for the WS payload.
      const requester = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, handle: true, displayName: true },
      });
      if (requester) {
        sendToUser(recipient.id, {
          type: "friend.request",
          from: { id: requester.id, handle: requester.handle ?? null, displayName: requester.displayName },
        });
      }
      reply.status(201).send({
        friendshipId: row.id,
        status: "pending-outgoing" as const,
        user: recipient,
      });
    },
  );

  const sendByHandleSchema = z.object({ handle: userHandleSchema });

  app.post(
    "/friends/request-by-handle",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 20, timeWindow: "1 hour" } },
    },
    async (request, reply) => {
      const parsed = sendByHandleSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid handle");
      const userId = request.auth!.userId;

      const recipient = await prisma.user.findUnique({
        where: { handleLower: parsed.data.handle.toLowerCase() },
        select: { id: true, displayName: true, email: true, handle: true },
      });
      if (!recipient) throw new NotFoundError("no user with that handle");
      if (recipient.id === userId) throw new ValidationError("cannot friend yourself");

      const existing = await prisma.friendship.findFirst({
        where: {
          OR: [
            { requesterId: userId, recipientId: recipient.id },
            { requesterId: recipient.id, recipientId: userId },
          ],
        },
      });
      if (existing) {
        if (existing.status === "blocked") throw new ConflictError("blocked");
        if (existing.status === "accepted") throw new ConflictError("already friends");
        if (existing.status === "pending") throw new ConflictError("request already pending");
      }

      let row;
      try {
        row = await prisma.friendship.create({
          data: { requesterId: userId, recipientId: recipient.id, status: "pending" },
        });
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("request already pending");
        }
        throw err;
      }
      // Fetch requester identity for the WS payload.
      const requesterByHandle = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, handle: true, displayName: true },
      });
      if (requesterByHandle) {
        sendToUser(recipient.id, {
          type: "friend.request",
          from: { id: requesterByHandle.id, handle: requesterByHandle.handle ?? null, displayName: requesterByHandle.displayName },
        });
      }
      reply.status(201).send({
        friendshipId: row.id,
        status: "pending-outgoing" as const,
        user: recipient,
      });
    },
  );

  app.post(
    "/friends/:id/accept",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = respondParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("missing id");
      const userId = request.auth!.userId;
      const row = await prisma.friendship.findUnique({ where: { id: parsed.data.id } });
      if (!row) throw new NotFoundError("friendship not found");
      if (row.recipientId !== userId) throw new AuthError("not the recipient");
      if (row.status !== "pending") throw new ValidationError("not pending");
      await prisma.friendship.update({
        where: { id: row.id },
        data: { status: "accepted", respondedAt: new Date() },
      });
      const accepter = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, handle: true, displayName: true },
      });
      if (accepter) {
        sendToUser(row.requesterId, {
          type: "friend.accepted",
          by: { id: accepter.id, handle: accepter.handle ?? null, displayName: accepter.displayName },
        });
      }
      reply.status(204).send();
    },
  );

  app.post(
    "/friends/:id/reject",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = respondParamsSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("missing id");
      const userId = request.auth!.userId;
      const row = await prisma.friendship.findUnique({ where: { id: parsed.data.id } });
      if (!row) throw new NotFoundError("friendship not found");
      if (row.recipientId !== userId && row.requesterId !== userId) {
        throw new AuthError("not a participant");
      }
      // Both reject (recipient declines) and cancel (requester withdraws) just
      // delete the row. accepted → reject means "unfriend".
      await prisma.friendship.delete({ where: { id: row.id } });
      reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------
  // Block (4.13 / 3.3a): replaces any existing pair row with a directional
  // blocked row where requester = blocker. Blocks friend requests both ways
  // and DM sends; the blocked party never sees the row.
  // ---------------------------------------------------------------------
  const blockBodySchema = z.object({ userId: z.string().uuid() });

  app.post(
    "/friends/block",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = blockBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid user id");
      const userId = request.auth!.userId;
      const targetId = parsed.data.userId;
      if (targetId === userId) throw new ValidationError("cannot block yourself");
      const target = await prisma.user.findUnique({
        where: { id: targetId },
        select: { id: true, displayName: true, email: true, handle: true },
      });
      if (!target) throw new NotFoundError("user not found");

      await prisma.$transaction(async (tx) => {
        await tx.friendship.deleteMany({
          where: {
            OR: [
              { requesterId: userId, recipientId: targetId },
              { requesterId: targetId, recipientId: userId },
            ],
          },
        });
        await tx.friendship.create({
          data: {
            requesterId: userId,
            recipientId: targetId,
            status: "blocked",
            respondedAt: new Date(),
          },
        });
      });
      // The other side's friend list changed under them — push, don't wait
      // for a reload (QA: blocked user kept seeing the friendship live).
      sendToUser(targetId, { type: "friend.removed", userId });
      reply.status(204).send();
    },
  );

  app.post<{ Params: { id: string } }>(
    "/friends/:id/unblock",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const row = await prisma.friendship.findUnique({ where: { id: request.params.id } });
      // Only the blocker may unblock, and only blocked rows qualify.
      if (!row || row.status !== "blocked" || row.requesterId !== userId) {
        throw new NotFoundError("block not found");
      }
      await prisma.friendship.delete({ where: { id: row.id } });
      reply.status(204).send();
    },
  );
}

/** True when either user has blocked the other. Used by chat send. */
export async function isBlockedPair(a: string, b: string): Promise<boolean> {
  const row = await prisma.friendship.findFirst({
    where: {
      status: "blocked",
      OR: [
        { requesterId: a, recipientId: b },
        { requesterId: b, recipientId: a },
      ],
    },
    select: { id: true },
  });
  return row !== null;
}
