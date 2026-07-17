import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { createInviteSchema, type InviteDTO } from "@r3dvoice/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { ForbiddenError, NotFoundError, ValidationError } from "../errors.js";
import { generateInviteCode } from "./code.js";
import { renderInvitePreview, renderInviteNotFound } from "./preview-html.js";
import { sendToUser } from "../chat/ws-state.js";

const idParamSchema = z.object({ id: z.string().uuid() });

function toDTO(inv: {
  id: string; code: string; kind: string; creatorId: string;
  targetRoomId: string | null; expiresAt: Date | null; maxUses: number | null;
  uses: number; revokedAt: Date | null; createdAt: Date;
}): InviteDTO {
  return {
    id: inv.id,
    code: inv.code,
    kind: inv.kind as "room" | "friend",
    creatorId: inv.creatorId,
    targetRoomId: inv.targetRoomId,
    expiresAt: inv.expiresAt?.toISOString() ?? null,
    maxUses: inv.maxUses,
    uses: inv.uses,
    revokedAt: inv.revokedAt?.toISOString() ?? null,
    createdAt: inv.createdAt.toISOString(),
  };
}

export async function inviteRoutes(app: FastifyInstance): Promise<void> {
  // Create
  app.post("/invites", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = createInviteSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
    const userId = request.auth!.userId;

    if (parsed.data.kind === "room") {
      const room = await prisma.room.findUnique({ where: { id: parsed.data.targetRoomId! } });
      if (!room) throw new NotFoundError("room not found");
      const isAllowed = room.ownerId === userId || (await prisma.roomMembership.findUnique({
        where: { userId_roomId: { userId, roomId: room.id } },
      })) !== null;
      if (!isAllowed) throw new NotFoundError("room not found"); // anti-enumeration
    }

    // Insert with retry on code collision (probabilistically rare).
    for (let attempt = 0; attempt < 3; attempt++) {
      const code = generateInviteCode();
      try {
        const created = await prisma.invite.create({
          data: {
            code,
            kind: parsed.data.kind,
            creatorId: userId,
            targetRoomId: parsed.data.targetRoomId ?? null,
            expiresAt: parsed.data.expiresAt ? new Date(parsed.data.expiresAt) : null,
            maxUses: parsed.data.maxUses ?? null,
          },
        });
        reply.status(201).send(toDTO(created));
        return;
      } catch (err) {
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") continue;
        throw err;
      }
    }
    throw new Error("failed to generate unique invite code after 3 attempts");
  });

  // List mine
  app.get("/invites", { preHandler: requireAuth }, async (request) => {
    const userId = request.auth!.userId;
    const rows = await prisma.invite.findMany({
      where: { creatorId: userId },
      orderBy: { createdAt: "desc" },
    });
    return { invites: rows.map(toDTO) };
  });

  // Revoke
  app.delete<{ Params: { id: string } }>(
    "/invites/:id",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = idParamSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("invalid id");
      const userId = request.auth!.userId;

      const inv = await prisma.invite.findUnique({
        where: { id: parsed.data.id },
        include: { targetRoom: { select: { ownerId: true } } },
      });
      if (!inv) throw new NotFoundError("invite not found");

      const isCreator = inv.creatorId === userId;
      const isRoomOwner = inv.targetRoom?.ownerId === userId;
      if (!isCreator && !isRoomOwner) throw new ForbiddenError("not allowed to revoke");

      if (inv.revokedAt) {
        reply.status(204).send();
        return;
      }
      await prisma.invite.update({
        where: { id: inv.id },
        data: { revokedAt: new Date() },
      });
      reply.status(204).send();
    },
  );

  const codeParamSchema = z.object({ code: z.string().min(8).max(8) });

  // Public preview — minimal metadata, NO room name leak.
  app.get<{ Params: { code: string } }>(
    "/invites/:code",
    {
      config: { rateLimit: { max: 60, timeWindow: "1 minute" } },
    },
    async (request) => {
      const parsed = codeParamSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("invalid code");

      const inv = await prisma.invite.findUnique({
        where: { code: parsed.data.code },
        include: { creator: { select: { handle: true, displayName: true } } },
      });
      if (!inv || !inv.creator.handle) throw new NotFoundError("invite not found");

      return {
        code: inv.code,
        kind: inv.kind,
        creator: { handle: inv.creator.handle, displayName: inv.creator.displayName },
        expiresAt: inv.expiresAt?.toISOString() ?? null,
        maxUses: inv.maxUses,
        uses: inv.uses,
        revokedAt: inv.revokedAt?.toISOString() ?? null,
      };
    },
  );

  // Authed full preview — reveals room name + count when kind=room.
  app.get<{ Params: { code: string } }>(
    "/invites/:code/full",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = codeParamSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("invalid code");

      const inv = await prisma.invite.findUnique({
        where: { code: parsed.data.code },
        include: {
          creator: { select: { handle: true, displayName: true } },
          targetRoom: { select: { id: true, name: true, _count: { select: { memberships: true } } } },
        },
      });
      if (!inv || !inv.creator.handle) throw new NotFoundError("invite not found");

      const base = {
        code: inv.code,
        kind: inv.kind,
        creator: { handle: inv.creator.handle, displayName: inv.creator.displayName },
        expiresAt: inv.expiresAt?.toISOString() ?? null,
        maxUses: inv.maxUses,
        uses: inv.uses,
        revokedAt: inv.revokedAt?.toISOString() ?? null,
      };
      if (inv.kind === "room" && inv.targetRoom) {
        return {
          ...base,
          targetRoom: {
            id: inv.targetRoom.id,
            name: inv.targetRoom.name,
            memberCount: inv.targetRoom._count.memberships,
          },
        };
      }
      return base;
    },
  );

  // Redeem
  app.post<{ Params: { code: string } }>(
    "/invites/:code/redeem",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = codeParamSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("invalid code");
      const userId = request.auth!.userId;

      const result = await prisma.$transaction(async (tx) => {
        const inv = await tx.invite.findUnique({ where: { code: parsed.data.code } });
        if (!inv) throw new NotFoundError("invite not found");
        if (inv.revokedAt) throw new ValidationError("invite revoked", "INVITE_REVOKED", 410);
        if (inv.expiresAt && inv.expiresAt.getTime() < Date.now()) {
          throw new ValidationError("invite expired", "INVITE_EXPIRED", 410);
        }
        if (inv.maxUses !== null && inv.uses >= inv.maxUses) {
          throw new ValidationError("invite full", "INVITE_FULL", 409);
        }
        if (inv.creatorId === userId) {
          throw new ValidationError("cannot redeem your own invite", "SELF_REDEEM", 400);
        }

        let alreadyApplied = false;

        if (inv.kind === "room") {
          if (!inv.targetRoomId) throw new Error("room invite missing targetRoomId");
          const existing = await tx.roomMembership.findUnique({
            where: { userId_roomId: { userId, roomId: inv.targetRoomId } },
          });
          if (existing) {
            alreadyApplied = true;
          } else {
            await tx.roomMembership.create({
              data: { userId, roomId: inv.targetRoomId, lastJoined: new Date() },
            });
          }
          if (!alreadyApplied) {
            await tx.invite.update({ where: { id: inv.id }, data: { uses: { increment: 1 } } });
          }
          return { kind: "room" as const, redirectTo: `/rooms/${inv.targetRoomId}` };
        }

        // friend
        const existingFs = await tx.friendship.findFirst({
          where: {
            OR: [
              { requesterId: inv.creatorId, recipientId: userId },
              { requesterId: userId, recipientId: inv.creatorId },
            ],
          },
        });
        if (existingFs) {
          if (existingFs.status === "accepted") {
            alreadyApplied = true;
          } else if (existingFs.status === "pending") {
            await tx.friendship.update({
              where: { id: existingFs.id },
              data: { status: "accepted", respondedAt: new Date() },
            });
          } else if (existingFs.status === "blocked") {
            throw new ValidationError("blocked", "BLOCKED", 403);
          }
        } else {
          await tx.friendship.create({
            data: {
              requesterId: inv.creatorId,
              recipientId: userId,
              status: "accepted",
              respondedAt: new Date(),
            },
          });
        }
        if (!alreadyApplied) {
          await tx.invite.update({ where: { id: inv.id }, data: { uses: { increment: 1 } } });
        }
        return { kind: "friend" as const, redirectTo: "/dms" };
      });

      // Fire invite.redeemed to the invite creator after the transaction.
      const redeemer = await prisma.user.findUnique({
        where: { id: userId },
        select: { id: true, handle: true, displayName: true },
      });
      const inviteAfter = await prisma.invite.findUnique({
        where: { code: parsed.data.code },
        select: { creatorId: true, code: true, kind: true, targetRoomId: true },
      });
      if (redeemer && inviteAfter) {
        sendToUser(inviteAfter.creatorId, {
          type: "invite.redeemed",
          code: inviteAfter.code,
          by: { id: redeemer.id, handle: redeemer.handle ?? null, displayName: redeemer.displayName },
          kind: inviteAfter.kind as "room" | "friend",
          targetRoomId: inviteAfter.targetRoomId,
        });
      }
      return result;
    },
  );

  // HTML preview page — public web landing at /invite/:code (singular path)
  app.get<{ Params: { code: string } }>(
    "/invite/:code",
    { config: { rateLimit: { max: 60, timeWindow: "1 minute" } } },
    async (request, reply) => {
      const parsed = codeParamSchema.safeParse(request.params);
      if (!parsed.success) {
        reply.code(404).type("text/html").send(renderInviteNotFound());
        return;
      }
      const inv = await prisma.invite.findUnique({
        where: { code: parsed.data.code },
        include: { creator: { select: { handle: true, displayName: true } } },
      });
      if (!inv || !inv.creator.handle) {
        reply.code(404).type("text/html").send(renderInviteNotFound());
        return;
      }
      const html = renderInvitePreview({
        code: inv.code,
        creatorHandle: inv.creator.handle,
        creatorDisplayName: inv.creator.displayName,
        expiresAt: inv.expiresAt,
        maxUses: inv.maxUses,
        uses: inv.uses,
        revokedAt: inv.revokedAt,
      });
      reply.type("text/html").send(html);
    },
  );
}
