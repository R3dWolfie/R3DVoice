import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { AuthError, ValidationError, NotFoundError } from "../errors.js";
import { isDmParticipant, isThreadType, type ThreadType } from "./threads.js";
import { isBlockedPair } from "../friends/routes.js";
import { broadcastToThread, sendToUser } from "./ws-state.js";
import { wrapAtRest, unwrapAtRest } from "../crypto-at-rest.js";

const sendBodySchema = z.object({
  threadType: z.enum(["room", "dm"]),
  threadId: z.string().min(1),
  body: z.string().min(1).max(4000),
});

const editBodySchema = z.object({
  body: z.string().min(1).max(4000),
});

const historyQuerySchema = z.object({
  threadType: z.enum(["room", "dm"]),
  threadId: z.string().min(1),
  before: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

interface MessageDTO {
  id: string;
  threadType: ThreadType;
  threadId: string;
  authorId: string;
  authorName: string;
  body: string | null;
  createdAt: string;
  editedAt: string | null;
  deletedAt: string | null;
  pinnedAt?: string | null;
  reactions?: Array<{ emoji: string; count: number; mine: boolean }>;
  mentions?: string[];
}

export function toDTO(m: {
  id: string;
  threadType: string;
  threadId: string;
  authorId: string;
  body: string;
  createdAt: Date;
  editedAt: Date | null;
  deletedAt: Date | null;
  pinnedAt?: Date | null;
  mentions: string | null;
  author: { displayName: string };
}): MessageDTO {
  // Room messages may be wrapped at rest with the server master key. DMs are
  // already client-side ciphertext envelopes — never wrapped server-side.
  let body: string | null = null;
  if (!m.deletedAt) {
    if (m.threadType === "room") {
      try {
        body = unwrapAtRest(m.body);
      } catch {
        body = m.body; // fall back to raw if unwrap fails (key changed?)
      }
    } else {
      body = m.body;
    }
  }
  const parsed = m.mentions ? (JSON.parse(m.mentions) as string[]) : undefined;
  return {
    id: m.id,
    threadType: m.threadType as ThreadType,
    threadId: m.threadId,
    authorId: m.authorId,
    authorName: m.author.displayName,
    body,
    createdAt: m.createdAt.toISOString(),
    editedAt: m.editedAt?.toISOString() ?? null,
    deletedAt: m.deletedAt?.toISOString() ?? null,
    pinnedAt: m.pinnedAt?.toISOString() ?? null,
    ...(parsed !== undefined && { mentions: parsed }),
  };
}

/** Wrap room-chat bodies at rest. DMs pass through (client already encrypted). */
function bodyForStorage(threadType: ThreadType, body: string): string {
  return threadType === "room" ? wrapAtRest(body) : body;
}

/** Aggregate reactions onto message DTOs: per-emoji count + whether the
 *  caller reacted. One query for the whole page. */
async function attachReactions(dtos: MessageDTO[], userId: string): Promise<void> {
  if (dtos.length === 0) return;
  const rows = await prisma.reaction.findMany({
    where: { messageId: { in: dtos.map((m) => m.id) } },
    select: { messageId: true, emoji: true, userId: true },
  });
  if (rows.length === 0) return;
  const byMessage = new Map<string, Map<string, { count: number; mine: boolean }>>();
  for (const r of rows) {
    let per = byMessage.get(r.messageId);
    if (!per) {
      per = new Map();
      byMessage.set(r.messageId, per);
    }
    const entry = per.get(r.emoji) ?? { count: 0, mine: false };
    entry.count += 1;
    if (r.userId === userId) entry.mine = true;
    per.set(r.emoji, entry);
  }
  for (const m of dtos) {
    const per = byMessage.get(m.id);
    if (per) {
      m.reactions = [...per.entries()].map(([emoji, e]) => ({ emoji, count: e.count, mine: e.mine }));
    }
  }
}

/**
 * Verify that `userId` is allowed to read/write `threadType`/`threadId`.
 * Throws AuthError if not. Loose checks for now: room access = membership exists
 * OR room owner; dm access = is one of the two canonical-pair participants.
 */
async function assertThreadAccess(
  threadType: ThreadType,
  threadId: string,
  userId: string,
): Promise<void> {
  if (threadType === "room") {
    const room = await prisma.room.findUnique({ where: { id: threadId } });
    if (!room) throw new NotFoundError("room not found");
    if (room.ownerId === userId) return;
    const membership = await prisma.roomMembership.findUnique({
      where: { userId_roomId: { userId, roomId: threadId } },
    });
    if (!membership) throw new AuthError("not a member of this room");
    return;
  }
  if (threadType === "dm") {
    if (!isDmParticipant(threadId, userId)) {
      throw new AuthError("not a participant of this DM thread");
    }
    return;
  }
  throw new ValidationError("unknown thread type");
}

export async function chatRoutes(app: FastifyInstance): Promise<void> {
  // GET /chat/messages?threadType=room&threadId=<id>&before=<iso>&limit=50
  app.get(
    "/chat/messages",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = historyQuerySchema.safeParse(request.query);
      if (!parsed.success) throw new ValidationError("invalid query");
      const { threadType, threadId, before, limit } = parsed.data;
      const userId = request.auth!.userId;
      await assertThreadAccess(threadType, threadId, userId);

      const messages = await prisma.message.findMany({
        where: {
          threadType,
          threadId,
          ...(before ? { createdAt: { lt: new Date(before) } } : {}),
        },
        include: { author: { select: { displayName: true } } },
        orderBy: [{ createdAt: "desc" }, { id: "desc" }],
        take: limit ?? 50,
      });

      // Return chronological-ascending so client can append directly.
      const dtos = messages.reverse().map(toDTO);
      await attachReactions(dtos, userId);
      return { messages: dtos };
    },
  );

  // POST /chat/messages — send to a thread.
  app.post(
    "/chat/messages",
    {
      preHandler: requireAuth,
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = sendBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
      const { threadType, threadId, body } = parsed.data;
      if (!isThreadType(threadType)) throw new ValidationError("unknown thread type");
      const userId = request.auth!.userId;
      await assertThreadAccess(threadType, threadId, userId);

      // Blocks close the pipe at SEND time only (4.13) — history stays
      // readable on both sides, matching the deck's block semantics.
      if (threadType === "dm") {
        const otherId = threadId.split(":").find((part) => part !== userId);
        if (otherId && (await isBlockedPair(userId, otherId))) {
          throw new AuthError("you can't message this user");
        }
      }

      // Resolve @handle tokens against the thread's participant set. Strict
      // regex requires a non-word character (or string start) before the @ so
      // we don't pick up email addresses or mid-token strings.
      const handleTokens: string[] = [];
      {
        const re = /(?:^|[^A-Za-z0-9_])@([A-Za-z0-9_]{3,24})\b/g;
        let m: RegExpExecArray | null;
        while ((m = re.exec(body)) !== null) {
          handleTokens.push(m[1]!.toLowerCase());
        }
      }

      let mentionedUserIds: string[] = [];
      if (handleTokens.length > 0) {
        let participantIds: string[];
        if (threadType === "room") {
          const memberships = await prisma.roomMembership.findMany({
            where: { roomId: threadId },
            select: { userId: true },
          });
          const room = await prisma.room.findUnique({
            where: { id: threadId },
            select: { ownerId: true },
          });
          participantIds = [...memberships.map((m) => m.userId)];
          if (room?.ownerId) participantIds.push(room.ownerId);
        } else {
          const [a, b] = threadId.split(":");
          participantIds = [a!, b!];
        }
        const candidates = await prisma.user.findMany({
          where: {
            id: { in: participantIds },
            handleLower: { in: handleTokens },
          },
          select: { id: true },
        });
        mentionedUserIds = candidates.map((c) => c.id);
      }

      const created = await prisma.message.create({
        data: {
          threadType,
          threadId,
          authorId: userId,
          body: bodyForStorage(threadType, body),
          mentions: mentionedUserIds.length > 0 ? JSON.stringify(mentionedUserIds) : null,
        },
        include: { author: { select: { displayName: true } } },
      });
      const dto = toDTO(created);
      broadcastToThread(threadType, threadId, { type: "message", message: dto });
      for (const mid of mentionedUserIds) {
        if (mid === userId) continue; // don't notify self
        sendToUser(mid, { type: "chat.mention", message: dto });
      }
      reply.status(201).send({ message: dto });
    },
  );

  // PATCH /chat/messages/:id — edit body (author-only).
  app.patch(
    "/chat/messages/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = (request.params as { id?: string }).id;
      if (!id) throw new ValidationError("missing id");
      const parsed = editBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid input");
      const userId = request.auth!.userId;
      const existing = await prisma.message.findUnique({
        where: { id },
        include: { author: { select: { displayName: true } } },
      });
      if (!existing) throw new NotFoundError("message not found");
      if (existing.authorId !== userId) throw new AuthError("not the author");
      if (existing.deletedAt) throw new ValidationError("cannot edit a deleted message");
      const updated = await prisma.message.update({
        where: { id },
        data: {
          body: bodyForStorage(existing.threadType as ThreadType, parsed.data.body),
          editedAt: new Date(),
        },
        include: { author: { select: { displayName: true } } },
      });
      const dto = toDTO(updated);
      broadcastToThread(updated.threadType as ThreadType, updated.threadId, {
        type: "edited",
        message: dto,
      });
      reply.send({ message: dto });
    },
  );

  // DELETE /chat/messages/:id — soft delete (author-only).
  app.delete(
    "/chat/messages/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const id = (request.params as { id?: string }).id;
      if (!id) throw new ValidationError("missing id");
      const userId = request.auth!.userId;
      const existing = await prisma.message.findUnique({ where: { id } });
      if (!existing) throw new NotFoundError("message not found");
      if (existing.authorId !== userId) throw new AuthError("not the author");
      await prisma.message.update({
        where: { id },
        data: { deletedAt: new Date() },
      });
      broadcastToThread(existing.threadType as ThreadType, existing.threadId, {
        type: "deleted",
        id,
        threadType: existing.threadType as ThreadType,
        threadId: existing.threadId,
      });
      reply.status(204).send();
    },
  );

  // GET /chat/dm-threads — list of DM threads for the current user with last
  // message preview. SQLite + Prisma can't do "distinct on" cleanly, so we
  // pull threadIds from the user's authored or received DMs and aggregate.
  app.get(
    "/chat/dm-threads",
    { preHandler: requireAuth },
    async (request) => {
      const userId = request.auth!.userId;
      // Find every DM thread containing this user. The canonical-pair encoding
      // lets us match via two LIKE patterns: `<userId>:%` and `%:<userId>`.
      const rows = await prisma.message.findMany({
        where: {
          threadType: "dm",
          OR: [{ threadId: { startsWith: `${userId}:` } }, { threadId: { endsWith: `:${userId}` } }],
        },
        orderBy: [{ createdAt: "desc" }],
        include: { author: { select: { displayName: true } } },
      });

      const seen = new Map<string, MessageDTO>();
      for (const m of rows) {
        if (seen.has(m.threadId)) continue;
        seen.set(m.threadId, toDTO(m));
      }

      // Resolve the OTHER half of each canonical-pair threadId in a single batch.
      const otherIds = new Set<string>();
      for (const threadId of seen.keys()) {
        const [a, b] = threadId.split(":");
        otherIds.add(a === userId ? b! : a!);
      }
      const others = await prisma.user.findMany({
        where: { id: { in: [...otherIds] } },
        select: { id: true, handle: true, displayName: true },
      });
      const otherById = new Map(others.map((u) => [u.id, u]));

      const threads = Array.from(seen.entries()).map(([threadId, lastMessage]) => {
        const [a, b] = threadId.split(":");
        const otherId = a === userId ? b! : a!;
        const other = otherById.get(otherId);
        return {
          threadId,
          lastMessage,
          otherParticipant: {
            id: otherId,
            handle: other?.handle ?? null,
            displayName: other?.displayName ?? "(unknown)",
          },
        };
      });
      return { threads };
    },
  );

  // ---------------------------------------------------------------------
  // Pins (2.5p): any thread participant can pin/unpin; pinned list is a
  // plain filtered query. Live updates ride a "pinned"/"unpinned" event.
  // ---------------------------------------------------------------------
  app.post<{ Params: { id: string } }>(
    "/chat/messages/:id/pin",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const msg = await prisma.message.findUnique({ where: { id: request.params.id } });
      if (!msg || msg.deletedAt) throw new NotFoundError("message not found");
      await assertThreadAccess(msg.threadType as ThreadType, msg.threadId, userId);
      const updated = await prisma.message.update({
        where: { id: msg.id },
        data: { pinnedAt: new Date(), pinnedById: userId },
        include: { author: { select: { displayName: true } } },
      });
      broadcastToThread(msg.threadType as ThreadType, msg.threadId, {
        type: "pinned",
        message: toDTO(updated),
      });
      reply.status(204).send();
    },
  );

  app.delete<{ Params: { id: string } }>(
    "/chat/messages/:id/pin",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const msg = await prisma.message.findUnique({ where: { id: request.params.id } });
      if (!msg) throw new NotFoundError("message not found");
      await assertThreadAccess(msg.threadType as ThreadType, msg.threadId, userId);
      await prisma.message.update({
        where: { id: msg.id },
        data: { pinnedAt: null, pinnedById: null },
      });
      broadcastToThread(msg.threadType as ThreadType, msg.threadId, {
        type: "unpinned",
        id: msg.id,
        threadType: msg.threadType,
        threadId: msg.threadId,
      });
      reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------
  // Reactions (2.5k): PUT adds the caller's reaction, DELETE removes it.
  // Broadcast keeps every open panel's chips live.
  // ---------------------------------------------------------------------
  const emojiParamOk = (e: string): boolean => e.length > 0 && e.length <= 16;

  app.put<{ Params: { id: string; emoji: string } }>(
    "/chat/messages/:id/reactions/:emoji",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const emoji = decodeURIComponent(request.params.emoji);
      if (!emojiParamOk(emoji)) throw new ValidationError("invalid emoji");
      const msg = await prisma.message.findUnique({ where: { id: request.params.id } });
      if (!msg || msg.deletedAt) throw new NotFoundError("message not found");
      await assertThreadAccess(msg.threadType as ThreadType, msg.threadId, userId);
      await prisma.reaction.upsert({
        where: { messageId_userId_emoji: { messageId: msg.id, userId, emoji } },
        create: { messageId: msg.id, userId, emoji },
        update: {},
      });
      broadcastToThread(msg.threadType as ThreadType, msg.threadId, {
        type: "reaction",
        op: "add",
        messageId: msg.id,
        threadType: msg.threadType,
        threadId: msg.threadId,
        emoji,
        userId,
      });
      reply.status(204).send();
    },
  );

  app.delete<{ Params: { id: string; emoji: string } }>(
    "/chat/messages/:id/reactions/:emoji",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const emoji = decodeURIComponent(request.params.emoji);
      if (!emojiParamOk(emoji)) throw new ValidationError("invalid emoji");
      const msg = await prisma.message.findUnique({ where: { id: request.params.id } });
      if (!msg) throw new NotFoundError("message not found");
      await assertThreadAccess(msg.threadType as ThreadType, msg.threadId, userId);
      await prisma.reaction.deleteMany({ where: { messageId: msg.id, userId, emoji } });
      broadcastToThread(msg.threadType as ThreadType, msg.threadId, {
        type: "reaction",
        op: "remove",
        messageId: msg.id,
        threadType: msg.threadType,
        threadId: msg.threadId,
        emoji,
        userId,
      });
      reply.status(204).send();
    },
  );

  app.get(
    "/chat/pins",
    { preHandler: requireAuth },
    async (request) => {
      const q = request.query as { threadType?: string; threadId?: string };
      if (!q.threadType || !q.threadId || !isThreadType(q.threadType)) {
        throw new ValidationError("threadType and threadId required");
      }
      const userId = request.auth!.userId;
      await assertThreadAccess(q.threadType, q.threadId, userId);
      const rows = await prisma.message.findMany({
        where: { threadType: q.threadType, threadId: q.threadId, pinnedAt: { not: null }, deletedAt: null },
        include: { author: { select: { displayName: true } } },
        orderBy: { pinnedAt: "desc" },
        take: 50,
      });
      return { messages: rows.map(toDTO) };
    },
  );
}
