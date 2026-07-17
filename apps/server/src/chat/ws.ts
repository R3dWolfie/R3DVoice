import type { FastifyInstance } from "fastify";
import websocket from "@fastify/websocket";
import { z } from "zod";
import { verifySessionToken } from "../auth/jwt.js";
import { getConfig } from "../config.js";
import { prisma } from "../db.js";
import { isDmParticipant, isThreadType } from "./threads.js";
import {
  subscribe,
  unsubscribe,
  unsubscribeAll,
  markOnline,
  markOffline,
  sendToUser,
  type ConnectedSocket,
} from "./ws-state.js";

const incomingSchema = z.union([
  z.object({
    type: z.literal("subscribe"),
    threadType: z.enum(["room", "dm"]),
    threadId: z.string().min(1),
  }),
  z.object({
    type: z.literal("unsubscribe"),
    threadType: z.enum(["room", "dm"]),
    threadId: z.string().min(1),
  }),
  z.object({ type: z.literal("ping") }),
]);

/**
 * WebSocket gateway for live chat events. Auth: client connects with the
 * Sec-WebSocket-Protocol subprotocol header set to "r3dvoice.bearer.<jwt>".
 * Subprotocol is the only browser-WebSocket way to ship a token without
 * exposing it in the URL. We require ws/ws.heartbeat ping every 30s.
 */
export async function chatWsRoutes(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get("/ws", { websocket: true }, (connection, request) => {
    // @fastify/websocket exposes the underlying ws.WebSocket on `connection`
    // (newer plugin versions) or `connection.socket` (older). Handle both.
    const sock = (connection as unknown as { socket?: import("ws").WebSocket })
      .socket ?? (connection as unknown as import("ws").WebSocket);

    // Token via subprotocol — Sec-WebSocket-Protocol: "r3dvoice.bearer.<jwt>".
    const proto = request.headers["sec-websocket-protocol"];
    const protoStr = Array.isArray(proto) ? proto[0] : proto;
    const token = extractTokenFromSubprotocol(protoStr);
    if (!token) {
      sock.close(4401, "missing auth subprotocol");
      return;
    }
    let userId: string;
    try {
      const claims = verifySessionToken(token, getConfig().JWT_SECRET);
      userId = claims.userId;
    } catch {
      sock.close(4401, "invalid token");
      return;
    }

    const conn: ConnectedSocket = { socket: sock, userId };
    markOnline(conn);

    sock.on("message", async (raw: Buffer | ArrayBuffer | Buffer[]) => {
      let payload: unknown;
      try {
        payload = JSON.parse(raw.toString());
      } catch {
        return; // ignore malformed
      }
      const parsed = incomingSchema.safeParse(payload);
      if (!parsed.success) return;
      const msg = parsed.data;

      if (msg.type === "ping") {
        try { sock.send(JSON.stringify({ type: "pong" })); } catch { /* ignore */ }
        return;
      }

      if (!isThreadType(msg.threadType)) return;

      // Authorize subscription. Reuse the same checks as REST.
      const allowed = await canAccessThread(msg.threadType, msg.threadId, userId);
      if (!allowed) {
        try { sock.send(JSON.stringify({ type: "error", code: "ACCESS_DENIED", threadId: msg.threadId })); } catch { /* ignore */ }
        return;
      }

      if (msg.type === "subscribe") subscribe(msg.threadType, msg.threadId, conn);
      else if (msg.type === "unsubscribe") unsubscribe(msg.threadType, msg.threadId, conn);
    });

    sock.on("close", () => {
      unsubscribeAll(conn);
      markOffline(conn);
      // Clear the user's currentRoomId on disconnect — otherwise crashed/
      // network-dropped clients leave their friends seeing them "in
      // <Room>" forever. We also broadcast presence.update so friends'
      // friend cards refresh immediately.
      void (async () => {
        try {
          const before = await prisma.user.findUnique({
            where: { id: userId },
            select: { currentRoomId: true },
          });
          if (!before?.currentRoomId) return;
          await prisma.user.update({
            where: { id: userId },
            data: { currentRoomId: null },
          });
          const friends = await prisma.friendship.findMany({
            where: {
              status: "accepted",
              OR: [{ requesterId: userId }, { recipientId: userId }],
            },
            select: { requesterId: true, recipientId: true },
          });
          const payload = { type: "presence.update" as const, userId, currentRoom: null };
          for (const f of friends) {
            const friendId = f.requesterId === userId ? f.recipientId : f.requesterId;
            sendToUser(friendId, payload);
          }
        } catch {
          /* best-effort cleanup */
        }
      })();
    });

    // Ack so client knows we're authenticated + ready.
    try {
      sock.send(JSON.stringify({ type: "ready", userId }));
    } catch {
      /* ignore */
    }
  });
}

function extractTokenFromSubprotocol(proto: string | undefined): string | null {
  if (!proto) return null;
  // Browsers send a comma-separated list. Find the bearer entry.
  const candidates = proto.split(",").map((s) => s.trim());
  for (const c of candidates) {
    if (c.startsWith("r3dvoice.bearer.")) {
      return c.slice("r3dvoice.bearer.".length);
    }
  }
  return null;
}

async function canAccessThread(
  threadType: "room" | "dm",
  threadId: string,
  userId: string,
): Promise<boolean> {
  if (threadType === "room") {
    const room = await prisma.room.findUnique({ where: { id: threadId } });
    if (!room) return false;
    if (room.ownerId === userId) return true;
    const m = await prisma.roomMembership.findUnique({
      where: { userId_roomId: { userId, roomId: threadId } },
    });
    return m !== null;
  }
  if (threadType === "dm") {
    return isDmParticipant(threadId, userId);
  }
  return false;
}
