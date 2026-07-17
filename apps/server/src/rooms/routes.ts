import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { mintLiveKitToken, kickParticipant, deleteLiveKitRoom } from "../livekit.js";
import { getConfig } from "../config.js";
import type { Room, RoomMembership } from "@prisma/client";

const createRoomSchema = z.object({
  name: z.string().trim().min(1).max(80),
  isPublic: z.boolean().optional(),
});

const updateRoomSchema = z.object({
  name: z.string().trim().min(1).max(80).optional(),
  isPublic: z.boolean().optional(),
});

const inviteSchema = z.object({
  userId: z.string().uuid(),
});

const transferSchema = z.object({
  newOwnerId: z.string().uuid(),
});

interface RoomResponse {
  id: string;
  name: string;
  ownerId: string;
  isPublic: boolean;
  createdAt: string;
  isOwner: boolean;
  lastJoined: string | null;
}

interface MemberResponse {
  userId: string;
  displayName: string;
  isOwner: boolean;
  joinedAt: string;
  lastJoined: string;
}

function toResponse(
  room: Room,
  currentUserId: string,
  membership: RoomMembership | null,
): RoomResponse {
  return {
    id: room.id,
    name: room.name,
    ownerId: room.ownerId,
    isPublic: room.isPublic,
    createdAt: room.createdAt.toISOString(),
    isOwner: room.ownerId === currentUserId,
    lastJoined: membership ? membership.lastJoined.toISOString() : null,
  };
}

async function loadRoomOr404(id: string): Promise<Room> {
  const room = await prisma.room.findUnique({ where: { id } });
  if (!room) throw new NotFoundError("room not found");
  return room;
}

function requireOwner(room: Room, userId: string): void {
  if (room.ownerId !== userId) throw new ForbiddenError("owner only");
}

export async function roomRoutes(app: FastifyInstance): Promise<void> {
  // ---------------------------------------------------------------------
  // Create
  // ---------------------------------------------------------------------
  app.post("/rooms", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createRoomSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
    }
    const room = await prisma.room.create({
      data: {
        name: parsed.data.name,
        ownerId: request.auth!.userId,
        isPublic: parsed.data.isPublic ?? false,
      },
    });
    reply.status(201).send(toResponse(room, request.auth!.userId, null));
  });

  // ---------------------------------------------------------------------
  // List my rooms
  // ---------------------------------------------------------------------
  app.get("/rooms", { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;
    const [owned, memberships] = await Promise.all([
      prisma.room.findMany({ where: { ownerId: userId }, orderBy: { createdAt: "desc" } }),
      prisma.roomMembership.findMany({
        where: { userId, room: { ownerId: { not: userId } } },
        include: { room: true },
        orderBy: { lastJoined: "desc" },
      }),
    ]);
    return {
      owned: owned.map((r) => toResponse(r, userId, null)),
      recent: memberships.map((m) => toResponse(m.room, userId, m)),
    };
  });

  // ---------------------------------------------------------------------
  // Get room — deck semantics: isPublic=false means UNLISTED, not private.
  // Knowing the room id IS the capability (ids only travel via links), so
  // any authenticated caller may resolve it. A true invite-only "Private"
  // tier is a future third visibility level with its own members-only gate.
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/rooms/:id",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      const membership = await prisma.roomMembership.findUnique({
        where: { userId_roomId: { userId, roomId: room.id } },
      });
      return toResponse(room, userId, membership);
    },
  );

  // ---------------------------------------------------------------------
  // Update room (owner only): rename, toggle isPublic
  // ---------------------------------------------------------------------
  app.patch<{ Params: { id: string } }>(
    "/rooms/:id",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      requireOwner(room, userId);
      const parsed = updateRoomSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
      }
      const data: { name?: string; isPublic?: boolean } = {};
      if (parsed.data.name !== undefined) data.name = parsed.data.name;
      if (parsed.data.isPublic !== undefined) data.isPublic = parsed.data.isPublic;
      const updated = await prisma.room.update({ where: { id: room.id }, data });
      return toResponse(updated, userId, null);
    },
  );

  // ---------------------------------------------------------------------
  // Delete room (owner only)
  // ---------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/rooms/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      requireOwner(room, userId);
      // Cascades on RoomMembership via FK; messages are loose by design and
      // stay in the table (they're already orphan-tolerant).
      await prisma.room.delete({ where: { id: room.id } });
      // Tear down the live LiveKit room so any currently-connected
      // participants get disconnected promptly, not just blocked from
      // future joins.
      void deleteLiveKitRoom(room.id);
      reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------
  // Transfer ownership (owner only) — `newOwnerId` must already be a member
  // so we don't accidentally transfer to a stranger by typo.
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/transfer",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      requireOwner(room, userId);
      const parsed = transferSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
      }
      const { newOwnerId } = parsed.data;
      if (newOwnerId === userId) throw new ValidationError("you already own this room");
      const targetMembership = await prisma.roomMembership.findUnique({
        where: { userId_roomId: { userId: newOwnerId, roomId: room.id } },
      });
      if (!targetMembership) {
        throw new ValidationError("target user must be a member of the room");
      }
      const updated = await prisma.room.update({
        where: { id: room.id },
        data: { ownerId: newOwnerId },
      });
      // Old owner stays as a regular member.
      await prisma.roomMembership.upsert({
        where: { userId_roomId: { userId, roomId: room.id } },
        create: { userId, roomId: room.id, lastJoined: new Date() },
        update: {},
      });
      return toResponse(updated, userId, null);
    },
  );

  // ---------------------------------------------------------------------
  // List members (owner / member / public-room caller). Members see other
  // members. Non-allowed callers get 404 by reusing the GET /rooms/:id gate.
  // ---------------------------------------------------------------------
  app.get<{ Params: { id: string } }>(
    "/rooms/:id/members",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      // Unlisted = link-is-access (see GET /rooms/:id); any authed caller
      // who has the id may see the member list.
      void userId;

      const memberships = await prisma.roomMembership.findMany({
        where: { roomId: room.id },
        include: { user: { select: { id: true, displayName: true } } },
        orderBy: { lastJoined: "desc" },
      });

      // Owner appears first even if they have no membership row (they don't
      // need one — ownership is the authority).
      const ownerUser = await prisma.user.findUnique({
        where: { id: room.ownerId },
        select: { id: true, displayName: true },
      });
      const out: MemberResponse[] = [];
      if (ownerUser) {
        const ownerMembership = memberships.find((m) => m.userId === room.ownerId);
        out.push({
          userId: ownerUser.id,
          displayName: ownerUser.displayName,
          isOwner: true,
          joinedAt: room.createdAt.toISOString(),
          lastJoined: ownerMembership?.lastJoined.toISOString() ?? room.createdAt.toISOString(),
        });
      }
      for (const m of memberships) {
        if (m.userId === room.ownerId) continue;
        out.push({
          userId: m.user.id,
          displayName: m.user.displayName,
          isOwner: false,
          joinedAt: m.lastJoined.toISOString(),
          lastJoined: m.lastJoined.toISOString(),
        });
      }
      return out;
    },
  );

  // ---------------------------------------------------------------------
  // Invite (owner only): explicitly grant access by user ID
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/members",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      requireOwner(room, userId);
      const parsed = inviteSchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
      }
      const target = await prisma.user.findUnique({
        where: { id: parsed.data.userId },
        select: { id: true, displayName: true },
      });
      if (!target) throw new NotFoundError("user not found");
      await prisma.roomMembership.upsert({
        where: { userId_roomId: { userId: target.id, roomId: room.id } },
        create: { userId: target.id, roomId: room.id, lastJoined: new Date() },
        update: {},
      });
      reply.status(201).send({
        userId: target.id,
        displayName: target.displayName,
        isOwner: false,
        joinedAt: new Date().toISOString(),
        lastJoined: new Date().toISOString(),
      });
    },
  );

  // ---------------------------------------------------------------------
  // Remove member (owner only) + LiveKit kick if they're connected
  // ---------------------------------------------------------------------
  app.delete<{ Params: { id: string; userId: string } }>(
    "/rooms/:id/members/:userId",
    { preHandler: requireAuth },
    async (request, reply) => {
      const callerId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      requireOwner(room, callerId);
      const targetUserId = request.params.userId;
      if (targetUserId === room.ownerId) {
        throw new ValidationError("cannot remove the owner — transfer or delete the room instead");
      }
      await prisma.roomMembership.deleteMany({
        where: { userId: targetUserId, roomId: room.id },
      });
      // Kick from LiveKit if they're currently connected — best effort.
      void kickParticipant(room.id, targetUserId);
      reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------
  // Leave room (self) — non-owners only
  // ---------------------------------------------------------------------
  app.delete<{ Params: { id: string } }>(
    "/rooms/:id/membership",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      if (room.ownerId === userId) {
        throw new ValidationError("owners cannot leave — transfer or delete the room");
      }
      await prisma.roomMembership.deleteMany({ where: { userId, roomId: room.id } });
      void kickParticipant(room.id, userId);
      reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------
  // Token mint — the access-control gate. Refuses non-allowed users.
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/rooms/:id/token",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const room = await loadRoomOr404(request.params.id);
      const user = await prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundError("user not found");

      // Unlisted = link-is-access: anyone authenticated with the room id may
      // join (deck 4.8: "Unlisted: anyone with the link can join"). The
      // future invite-only Private tier re-introduces a gate here.

      // Refresh / create membership so the room shows up under "Recent".
      // Owner doesn't need a membership row but we create one anyway so
      // they appear in the members list with a lastJoined timestamp.
      await prisma.roomMembership.upsert({
        where: { userId_roomId: { userId, roomId: room.id } },
        create: { userId, roomId: room.id, lastJoined: new Date() },
        update: { lastJoined: new Date() },
      });

      const token = await mintLiveKitToken({
        userId: user.id,
        displayName: user.displayName,
        roomId: room.id,
      });

      return {
        token,
        url: getConfig().LIVEKIT_URL,
        roomId: room.id,
      };
    },
  );
}
