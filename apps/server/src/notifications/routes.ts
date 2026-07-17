import type { FastifyInstance } from "fastify";
import { markReadSchema, setMuteSchema, setDndSchema } from "@r3dvoice/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { ValidationError } from "../errors.js";
import { computeUnread } from "./unread.js";
import type { NotificationsFeedDTO, MentionFeedItemDTO } from "@r3dvoice/shared";
import { toDTO as messageToDTO } from "../chat/routes.js";

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  app.post("/chat/read", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = markReadSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError("invalid input");
    const userId = request.auth!.userId;
    const lastReadAt = parsed.data.lastReadAt ? new Date(parsed.data.lastReadAt) : new Date();

    await prisma.threadReadState.upsert({
      where: {
        userId_threadType_threadId: {
          userId,
          threadType: parsed.data.threadType,
          threadId: parsed.data.threadId,
        },
      },
      create: {
        userId,
        threadType: parsed.data.threadType,
        threadId: parsed.data.threadId,
        lastReadAt,
      },
      update: { lastReadAt },
    });
    reply.status(204).send();
  });

  app.get("/chat/unread", { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;
    return await computeUnread(userId);
  });

  app.get<{ Params: { threadType: string; threadId: string } }>(
    "/chat/threads/:threadType/:threadId/mute",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      const { threadType, threadId } = request.params;
      if (threadType !== "room" && threadType !== "dm") {
        throw new ValidationError("invalid threadType");
      }
      const row = await prisma.threadMuteState.findUnique({
        where: { userId_threadType_threadId: { userId, threadType, threadId } },
      });
      // Absent row means default ("all"); the row is only persisted when
      // the user picks something other than the default.
      return {
        threadType,
        threadId,
        level: row?.level ?? "all",
        mutedUntil: row?.mutedUntil?.toISOString() ?? null,
      };
    },
  );

  app.patch<{ Params: { threadType: string; threadId: string } }>(
    "/chat/threads/:threadType/:threadId/mute",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = setMuteSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid input");
      const userId = request.auth!.userId;
      const { threadType, threadId } = request.params;
      if (threadType !== "room" && threadType !== "dm") {
        throw new ValidationError("invalid threadType");
      }

      // level="all" with no mutedUntil = clear (delete row); spec says
      // default-state is implicit, not stored.
      if (parsed.data.level === "all" && !parsed.data.mutedUntil) {
        await prisma.threadMuteState.deleteMany({
          where: { userId, threadType, threadId },
        });
        reply.status(204).send();
        return;
      }

      await prisma.threadMuteState.upsert({
        where: { userId_threadType_threadId: { userId, threadType, threadId } },
        create: {
          userId, threadType, threadId,
          level: parsed.data.level,
          mutedUntil: parsed.data.mutedUntil ? new Date(parsed.data.mutedUntil) : null,
        },
        update: {
          level: parsed.data.level,
          mutedUntil: parsed.data.mutedUntil ? new Date(parsed.data.mutedUntil) : null,
        },
      });
      reply.status(204).send();
    },
  );

  app.patch("/me/dnd", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = setDndSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError("invalid input");
    const userId = request.auth!.userId;
    await prisma.user.update({
      where: { id: userId },
      data: { dndUntil: parsed.data.until ? new Date(parsed.data.until) : null },
    });
    reply.status(204).send();
  });

  // GET /notifications/feed — one round trip for the 4.15 bell panel:
  // recent mentions of the caller (with room context) + pending directed
  // room invites. Friend requests ride the existing /friends endpoint.
  app.get("/notifications/feed", { preHandler: requireAuth }, async (request): Promise<NotificationsFeedDTO> => {
    const userId = request.auth!.userId;

    const [me, mentionRows, inviteRows] = await Promise.all([
      prisma.user.findUnique({ where: { id: userId }, select: { notificationsSeenAt: true } }),
      // mentions is a JSON array of uuids; a contains-substring match on the
      // uuid is exact in practice (uuids don't nest inside each other).
      prisma.message.findMany({
        where: {
          mentions: { contains: userId },
          deletedAt: null,
          authorId: { not: userId },
        },
        orderBy: { createdAt: "desc" },
        take: 30,
        include: { author: { select: { displayName: true } } },
      }),
      prisma.directInvite.findMany({
        where: { toUserId: userId, status: "pending", expiresAt: { gt: new Date() } },
        orderBy: { createdAt: "desc" },
        take: 20,
        include: {
          room: { select: { id: true, name: true } },
          from: { select: { id: true, displayName: true, handle: true, avatarUrl: true } },
        },
      }),
    ]);

    // Resolve room names for room-thread mentions in one query.
    const roomIds = [...new Set(mentionRows.filter((m) => m.threadType === "room").map((m) => m.threadId))];
    const rooms = roomIds.length
      ? await prisma.room.findMany({ where: { id: { in: roomIds } }, select: { id: true, name: true } })
      : [];
    const roomName = new Map(rooms.map((r) => [r.id, r.name]));

    const mentions: MentionFeedItemDTO[] = mentionRows.map((m) => ({
      message: messageToDTO(m),
      roomId: m.threadType === "room" ? m.threadId : null,
      roomName: m.threadType === "room" ? (roomName.get(m.threadId) ?? null) : null,
    }));

    // Live in-call counts per invited room, one groupBy for all of them.
    const inviteRoomIds = [...new Set(inviteRows.map((i) => i.roomId))];
    const liveCounts = inviteRoomIds.length
      ? await prisma.user.groupBy({
          by: ["currentRoomId"],
          where: { currentRoomId: { in: inviteRoomIds } },
          _count: { _all: true },
        })
      : [];
    const liveByRoom = new Map(liveCounts.map((g) => [g.currentRoomId, g._count._all]));

    return {
      seenAt: me?.notificationsSeenAt?.toISOString() ?? null,
      mentions,
      invites: inviteRows.map((inv) => ({
        id: inv.id,
        room: { id: inv.room.id, name: inv.room.name },
        from: {
          id: inv.from.id,
          displayName: inv.from.displayName,
          handle: inv.from.handle,
          avatarUrl: inv.from.avatarUrl,
        },
        membersLive: liveByRoom.get(inv.roomId) ?? 0,
        createdAt: inv.createdAt.toISOString(),
        expiresAt: inv.expiresAt.toISOString(),
      })),
    };
  });

  // POST /notifications/read-all — 4.15 "Mark all read" watermark.
  app.post("/notifications/read-all", { preHandler: requireAuth }, async (request, reply) => {
    await prisma.user.update({
      where: { id: request.auth!.userId },
      data: { notificationsSeenAt: new Date() },
    });
    reply.status(204).send();
  });
}
