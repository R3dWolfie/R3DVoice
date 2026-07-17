import type { FastifyInstance } from "fastify";
import { userHandleSchema } from "@r3dvoice/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../auth/middleware.js";
import { ConflictError, NotFoundError, ValidationError } from "../errors.js";

const setHandleSchema = z.object({ handle: userHandleSchema });
const handleParamSchema = z.object({ handle: z.string() });

export async function userRoutes(app: FastifyInstance): Promise<void> {
  app.post("/me/handle", { preHandler: requireAuth }, async (request) => {
    const parsed = setHandleSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid handle");
    const userId = request.auth!.userId;

    // Store the user-typed casing for display, plus the canonical lowercase
    // form on which the unique constraint lives. @Red and @red collide.
    const handle = parsed.data.handle;
    const handleLower = handle.toLowerCase();

    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { handle, handleLower },
        select: { id: true, handle: true, displayName: true, email: true },
      });
      return updated;
    } catch (err) {
      if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
        throw new ConflictError("handle taken", "HANDLE_TAKEN");
      }
      throw err;
    }
  });

  const updateMeSchema = z.object({
    avatarUrl: z
      .string()
      .url()
      .max(2048)
      .startsWith("https://")
      .nullable()
      .optional(),
  });

  app.patch("/me", { preHandler: requireAuth }, async (request) => {
    const parsed = updateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
    }
    const userId = request.auth!.userId;

    const data: { avatarUrl?: string | null } = {};
    if (parsed.data.avatarUrl !== undefined) {
      data.avatarUrl = parsed.data.avatarUrl;
    }

    const user = await prisma.user.update({
      where: { id: userId },
      data,
    });

    return {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      handle: user.handle ?? null,
      avatarUrl: user.avatarUrl ?? null,
      dndUntil: user.dndUntil?.toISOString() ?? null,
      totpEnabled: user.totpEnabledAt !== null,
      hasE2eeKey: user.e2eePublicKey !== null,
    };
  });

  app.get<{ Params: { handle: string } }>(
    "/users/by-handle/:handle",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = handleParamSchema.safeParse(request.params);
      if (!parsed.success) throw new ValidationError("invalid handle");
      const lower = parsed.data.handle.toLowerCase();
      const user = await prisma.user.findUnique({
        where: { handleLower: lower },
        select: { id: true, handle: true, displayName: true },
      });
      if (!user) throw new NotFoundError("user not found");
      return user;
    },
  );
}
