import type { FastifyInstance } from "fastify";
import { markReadSchema, setMuteSchema, setDndSchema } from "@r3dvoice/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { ValidationError } from "../errors.js";
import { computeUnread } from "./unread.js";

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
}
