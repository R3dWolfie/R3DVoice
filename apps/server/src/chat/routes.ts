import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { writeFile, mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import type { MessageAttachment, PollOption, PollDTO } from "@r3dvoice/shared";
import { prisma } from "../db.js";
import { getConfig } from "../config.js";
import { requireAuth } from "../auth/middleware.js";
import { AuthError, ValidationError, NotFoundError } from "../errors.js";
import { dmThreadId, isThreadType, type ThreadType } from "./threads.js";
import { isBlockedPair } from "../friends/routes.js";
import { broadcastToThread, sendToUser } from "./ws-state.js";
import { wrapAtRest, unwrapAtRest } from "../crypto-at-rest.js";

/** On-disk poll shape (Message.poll JSON). The DTO collapses `votes` to a
 *  tally + the viewer's own choice + a distinct-voter total. */
interface StoredPoll {
  question: string;
  options: PollOption[];
  /** userId → chosen optionId. One entry per voter (single-choice). */
  votes: Record<string, string>;
}

const attachmentInputSchema = z.object({
  url: z.string().min(1),
  name: z.string().min(1),
  mime: z.string().min(1),
  size: z.number().int().nonnegative(),
});

const sendBodySchema = z
  .object({
    threadType: z.enum(["room", "dm"]),
    threadId: z.string().min(1),
    // Optional now: a message may carry only attachments or a poll (empty body).
    body: z.string().max(4000).optional(),
    attachments: z.array(attachmentInputSchema).max(10).optional(),
    poll: z
      .object({
        question: z.string().min(1).max(300),
        options: z.array(z.string().min(1).max(120)).min(2).max(6),
      })
      .optional(),
  })
  // Require SOMETHING to send: a non-empty body, at least one attachment, or a
  // poll. An all-empty payload is a 400.
  .refine(
    (d) =>
      (typeof d.body === "string" && d.body.length > 0) ||
      (Array.isArray(d.attachments) && d.attachments.length > 0) ||
      d.poll !== undefined,
    { message: "message needs a body, an attachment, or a poll", path: ["body"] },
  );

const editBodySchema = z.object({
  body: z.string().min(1).max(4000),
});

const historyQuerySchema = z.object({
  threadType: z.enum(["room", "dm"]),
  threadId: z.string().min(1),
  // ISO-8601 only: a garbage cursor used to become new Date('garbage') → Prisma
  // 500. Reject it as a 400 at the edge instead.
  before: z.string().datetime().optional(),
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
  attachments?: MessageAttachment[];
  poll?: PollDTO | null;
}

export function toDTO(
  m: {
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
    attachments: string | null;
    poll: string | null;
    author: { displayName: string };
  },
  opts?: { viewerId?: string },
): MessageDTO {
  const viewerId = opts?.viewerId;
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
  const dto: MessageDTO = {
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

  // Attachments: stored as a JSON array. Omit the field on null/empty/garbage.
  if (m.attachments) {
    try {
      const arr = JSON.parse(m.attachments) as MessageAttachment[];
      if (Array.isArray(arr) && arr.length > 0) dto.attachments = arr;
    } catch {
      // malformed JSON → present no attachments rather than 500
    }
  }

  // Poll: collapse the raw voter map into a tally + the viewer's own vote.
  if (m.poll) {
    try {
      const stored = JSON.parse(m.poll) as StoredPoll;
      const tally: Record<string, number> = {};
      for (const opt of stored.options) tally[opt.id] = 0;
      for (const optId of Object.values(stored.votes)) {
        tally[optId] = (tally[optId] ?? 0) + 1;
      }
      dto.poll = {
        question: stored.question,
        options: stored.options,
        tally,
        myVote: viewerId ? (stored.votes[viewerId] ?? null) : null,
        totalVotes: Object.keys(stored.votes).length,
      };
    } catch {
      // malformed poll JSON → treat as no poll
    }
  }

  return dto;
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
    // Canonicalize server-side: a crafted client could otherwise POST to a
    // reverse-ordered (Y:X) or bogus-peer thread, spawning phantom rows and
    // phantom unread. Recompute the canonical id from the two user-ids, require
    // exactly one of them to be the caller, and reject anything non-canonical.
    const parts = threadId.split(":");
    const other = parts.length === 2
      ? (parts[0] === userId ? parts[1]! : parts[1] === userId ? parts[0]! : null)
      : null;
    if (!other) throw new AuthError("not a participant of this DM thread");
    let canonical: string;
    try {
      canonical = dmThreadId(userId, other); // validates both are UUIDs, not self
    } catch {
      throw new ValidationError("invalid DM thread id");
    }
    if (canonical !== threadId) throw new ValidationError("non-canonical DM thread id");
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
      const dtos = messages.reverse().map((msg) => toDTO(msg, { viewerId: userId }));
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
      const { threadType, threadId, attachments, poll } = parsed.data;
      const body = parsed.data.body ?? "";
      if (!isThreadType(threadType)) throw new ValidationError("unknown thread type");
      const userId = request.auth!.userId;
      await assertThreadAccess(threadType, threadId, userId);

      // Attachments + polls are ROOM-only. DMs are end-to-end encrypted, so we
      // must never store plaintext poll state or host their files server-side.
      if (threadType === "dm" && (attachments !== undefined || poll !== undefined)) {
        throw new ValidationError("attachments and polls are not available in encrypted DMs");
      }

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

      // Poll storage: seed the stable option ids + an empty voter map. Only
      // reachable for rooms (DM guard above).
      const pollJson = poll
        ? JSON.stringify({
            question: poll.question,
            options: poll.options.map((text, i) => ({ id: String(i), text })),
            votes: {},
          } satisfies StoredPoll)
        : null;

      const created = await prisma.message.create({
        data: {
          threadType,
          threadId,
          authorId: userId,
          body: bodyForStorage(threadType, body),
          mentions: mentionedUserIds.length > 0 ? JSON.stringify(mentionedUserIds) : null,
          attachments: attachments && attachments.length > 0 ? JSON.stringify(attachments) : null,
          poll: pollJson,
        },
        include: { author: { select: { displayName: true } } },
      });
      const dto = toDTO(created, { viewerId: userId });
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
      const dto = toDTO(updated, { viewerId: userId });
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
      // Only threadId strings — cheap — instead of the whole DM history.
      const threadRows = await prisma.message.findMany({
        where: {
          threadType: "dm",
          OR: [{ threadId: { startsWith: `${userId}:` } }, { threadId: { endsWith: `:${userId}` } }],
        },
        select: { threadId: true },
        distinct: ["threadId"],
        orderBy: { createdAt: "desc" },
      });
      // Bound the fan-out: most-recently-active threads first.
      const dmThreadIds = threadRows.map((r) => r.threadId).slice(0, 500);

      const seen = new Map<string, MessageDTO>();
      if (dmThreadIds.length > 0) {
        // Preview = newest NON-deleted message per thread; fall back to the newest
        // message overall when a thread is entirely deleted (preserves the old
        // full-scan semantics without loading every message).
        const [liveMax, anyMax] = await Promise.all([
          prisma.message.groupBy({
            by: ["threadId"],
            where: { threadType: "dm", threadId: { in: dmThreadIds }, deletedAt: null },
            _max: { createdAt: true },
          }),
          prisma.message.groupBy({
            by: ["threadId"],
            where: { threadType: "dm", threadId: { in: dmThreadIds } },
            _max: { createdAt: true },
          }),
        ]);
        const liveByThread = new Map(liveMax.map((g) => [g.threadId, g._max.createdAt]));
        const anyByThread = new Map(anyMax.map((g) => [g.threadId, g._max.createdAt]));

        // One row per thread: the chosen preview message. Single query via a
        // (threadId, createdAt) OR-list, then bucket newest-first per thread.
        const wanted = dmThreadIds
          .map((threadId) => ({ threadId, at: liveByThread.get(threadId) ?? anyByThread.get(threadId) ?? null }))
          .filter((w): w is { threadId: string; at: Date } => w.at !== null);
        if (wanted.length > 0) {
          const picked = await prisma.message.findMany({
            where: { OR: wanted.map((w) => ({ threadId: w.threadId, createdAt: w.at })) },
            include: { author: { select: { displayName: true } } },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
          });
          for (const m of picked) {
            if (!seen.has(m.threadId)) seen.set(m.threadId, toDTO(m, { viewerId: userId }));
          }
        }
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
        message: toDTO(updated, { viewerId: userId }),
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
      return { messages: rows.map((m) => toDTO(m, { viewerId: userId })) };
    },
  );

  // ---------------------------------------------------------------------
  // Attachment upload (#30). The client sends a file as a base64 data: URL;
  // we decode, cap size, and write it under <UPLOADS_DIR>/attachments/, then
  // hand back the served URL for the sender to attach to a room message.
  // Room-only by product decision (DMs are E2EE — no server-hosted files).
  // ---------------------------------------------------------------------
  const attachmentUploadSchema = z.object({
    // ~8 MB decoded ≈ ~10.9 MB base64; cap the string generously below the
    // 12 MB route bodyLimit so oversize hits our friendly 400, not a raw 413.
    dataUrl: z.string().min(1).max(16_000_000),
    name: z.string().min(1).max(255),
  });

  // Strip any directory components / control chars from a client-supplied
  // filename so it can't traverse paths or smuggle newlines into a header.
  const sanitizeName = (raw: string): string => {
    const base = raw.replace(/\\/g, "/").split("/").pop() ?? "file";
    const cleaned = base.replace(/[\x00-\x1f\x7f]/g, "").trim();
    return cleaned.length > 0 ? cleaned.slice(0, 200) : "file";
  };

  const MIME_EXT: Record<string, string> = {
    "image/png": "png",
    "image/jpeg": "jpg",
    "image/gif": "gif",
    "image/webp": "webp",
    "video/mp4": "mp4",
    "video/webm": "webm",
    "audio/mpeg": "mp3",
    "audio/ogg": "ogg",
    "audio/wav": "wav",
    "application/pdf": "pdf",
    "text/plain": "txt",
    "application/zip": "zip",
    "application/json": "json",
  };

  // Permissive allow-list. text/html + anything SVG can execute script when
  // served from our origin, so they're refused outright (XSS).
  const mimeAllowed = (mime: string): boolean => {
    if (mime === "text/html" || mime === "application/xhtml+xml") return false;
    if (mime.includes("svg")) return false;
    return (
      mime.startsWith("image/") ||
      mime.startsWith("video/") ||
      mime.startsWith("audio/") ||
      mime === "application/pdf" ||
      mime === "text/plain" ||
      mime === "application/json" ||
      mime === "application/zip" ||
      mime === "application/x-zip-compressed" ||
      mime === "application/octet-stream" ||
      mime === "application/msword" ||
      mime.startsWith("application/vnd.")
    );
  };

  app.post(
    "/uploads/attachment",
    {
      preHandler: requireAuth,
      // Default Fastify bodyLimit is 1 MiB — far too small for an ~8 MB file
      // sent as a base64 data URL (~10.9 MB) plus JSON overhead. Raise it PER
      // ROUTE (not globally) so only this authenticated endpoint accepts big
      // bodies; everything else keeps the tight default.
      bodyLimit: 12 * 1024 * 1024,
      config: { rateLimit: { max: 30, timeWindow: "1 minute" } },
    },
    async (request) => {
      const parsed = attachmentUploadSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid upload");

      const m = /^data:([a-zA-Z0-9!#$&^_.+-]+\/[a-zA-Z0-9!#$&^_.+-]+);base64,(.+)$/s.exec(
        parsed.data.dataUrl,
      );
      if (!m) throw new ValidationError("expected a base64 data: URL");
      const mime = m[1]!.toLowerCase();
      if (!mimeAllowed(mime)) throw new ValidationError("file type not allowed");

      const bytes = Buffer.from(m[2]!, "base64");
      if (bytes.length === 0) throw new ValidationError("empty file");
      if (bytes.length > 8 * 1024 * 1024) throw new ValidationError("file too large (max 8 MB)");

      const name = sanitizeName(parsed.data.name);
      const nameExt = /\.([a-zA-Z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase();
      const ext = nameExt ?? MIME_EXT[mime] ?? mime.split("/")[1]?.replace(/[^a-z0-9]/g, "").slice(0, 8) ?? "bin";

      const cfg = getConfig();
      const dir = join(resolve(cfg.UPLOADS_DIR), "attachments");
      await mkdir(dir, { recursive: true });
      const fileName = `${randomUUID()}.${ext || "bin"}`;
      await writeFile(join(dir, fileName), bytes);

      const url = `${cfg.APP_URL.replace(/\/$/, "")}/uploads/attachments/${fileName}`;
      return { url, name, mime, size: bytes.length } satisfies MessageAttachment;
    },
  );

  // ---------------------------------------------------------------------
  // Poll voting (#29). Single-choice: casting a vote replaces any prior one;
  // voting the same option again toggles it OFF. Broadcasts the updated
  // message over the same "edited" event the edit route uses so every open
  // panel re-renders the poll in place (tally/totalVotes are viewer-agnostic;
  // myVote in the broadcast reflects the voter and self-corrects on refetch).
  // ---------------------------------------------------------------------
  const voteBodySchema = z.object({ optionId: z.string().min(1) });
  app.post<{ Params: { id: string } }>(
    "/chat/messages/:id/vote",
    { preHandler: requireAuth },
    async (request, reply) => {
      const userId = request.auth!.userId;
      const parsed = voteBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("optionId required");
      const optionId = parsed.data.optionId;

      const msg = await prisma.message.findUnique({
        where: { id: request.params.id },
        include: { author: { select: { displayName: true } } },
      });
      if (!msg || msg.deletedAt || !msg.poll) throw new NotFoundError("poll not found");
      await assertThreadAccess(msg.threadType as ThreadType, msg.threadId, userId);

      let stored: StoredPoll;
      try {
        stored = JSON.parse(msg.poll) as StoredPoll;
      } catch {
        throw new NotFoundError("poll not found");
      }
      if (!stored.options.some((o) => o.id === optionId)) {
        throw new ValidationError("invalid poll option");
      }

      if (stored.votes[userId] === optionId) {
        delete stored.votes[userId]; // toggle off
      } else {
        stored.votes[userId] = optionId;
      }

      const updated = await prisma.message.update({
        where: { id: msg.id },
        data: { poll: JSON.stringify(stored) },
        include: { author: { select: { displayName: true } } },
      });
      const dto = toDTO(updated, { viewerId: userId });
      broadcastToThread(updated.threadType as ThreadType, updated.threadId, {
        type: "edited",
        message: dto,
      });
      reply.send({ message: dto });
    },
  );
}
