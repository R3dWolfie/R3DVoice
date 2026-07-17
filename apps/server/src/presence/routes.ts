import type { FastifyInstance } from "fastify";
import { setPresenceSchema } from "@r3dvoice/shared";
import { prisma } from "../db.js";
import { requireAuth } from "../auth/middleware.js";
import { ValidationError } from "../errors.js";
import { sendToUser } from "../chat/ws-state.js";

export async function presenceRoutes(app: FastifyInstance): Promise<void> {
  app.post("/me/presence", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = setPresenceSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError("invalid input");
    const userId = request.auth!.userId;
    await prisma.user.update({
      where: { id: userId },
      data: { currentRoomId: parsed.data.roomId },
    });

    const room = parsed.data.roomId
      ? await prisma.room.findUnique({ where: { id: parsed.data.roomId }, select: { id: true, name: true } })
      : null;

    const friendships = await prisma.friendship.findMany({
      where: {
        status: "accepted",
        OR: [{ requesterId: userId }, { recipientId: userId }],
      },
      select: { requesterId: true, recipientId: true },
    });
    const friendIds = new Set<string>();
    for (const f of friendships) {
      friendIds.add(f.requesterId === userId ? f.recipientId : f.requesterId);
    }
    const payload = { type: "presence.update" as const, userId, currentRoom: room };
    for (const fid of friendIds) {
      sendToUser(fid, payload);
    }

    reply.status(204).send();
  });
}
