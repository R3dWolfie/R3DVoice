import type { FastifyInstance } from "fastify";
import { userHandleSchema } from "@r3dvoice/shared";
import { z } from "zod";
import { prisma } from "../db.js";
import { Prisma } from "@prisma/client";
import { requireAuth } from "../auth/middleware.js";
import { verifyPassword } from "../auth/password.js";
import { AuthError, ConflictError, NotFoundError, ValidationError } from "../errors.js";
import { writeFile, mkdir, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { getConfig } from "../config.js";

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
    displayName: z.string().trim().min(1).max(50).optional(),
  });

  // 4.12 - delete account. Password re-auth server-side (the type-handle
  // confirm is client UX, not security). User row cascades: sessions,
  // owned rooms (disconnecting their members), memberships, friendships.
  const deleteMeSchema = z.object({ password: z.string().min(1) });
  app.delete("/me", { preHandler: requireAuth }, async (request, reply) => {
    const parsed = deleteMeSchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError("password required");
    const userId = request.auth!.userId;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw new NotFoundError("user not found");
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) throw new AuthError("wrong password");
    await prisma.user.delete({ where: { id: userId } });
    reply.status(204).send();
  });

  app.patch("/me", { preHandler: requireAuth }, async (request) => {
    const parsed = updateMeSchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
    }
    const userId = request.auth!.userId;

    const data: { avatarUrl?: string | null; displayName?: string } = {};
    if (parsed.data.avatarUrl !== undefined) {
      data.avatarUrl = parsed.data.avatarUrl;
    }
    if (parsed.data.displayName !== undefined) {
      data.displayName = parsed.data.displayName;
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

  // Upload a profile picture. The client resizes to a small square and sends a
  // data: URL; we decode, cap the size, write it under <UPLOADS_DIR>/avatars,
  // and point avatarUrl at the served file (with a content hash so the stable
  // filename still busts caches when the picture changes).
  const avatarUploadSchema = z.object({
    dataUrl: z.string().startsWith("data:image/").max(1_400_000),
  });
  app.post(
    "/me/avatar",
    { preHandler: requireAuth, config: { rateLimit: { max: 20, timeWindow: "1 hour" } } },
    async (request) => {
      const parsed = avatarUploadSchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid image");
      const userId = request.auth!.userId;

      const m = /^data:image\/(png|jpeg|webp);base64,(.+)$/s.exec(parsed.data.dataUrl);
      if (!m) throw new ValidationError("unsupported image (png, jpeg or webp only)");
      const ext = m[1] === "jpeg" ? "jpg" : m[1]!;
      const bytes = Buffer.from(m[2]!, "base64");
      if (bytes.length === 0) throw new ValidationError("empty image");
      if (bytes.length > 1_000_000) throw new ValidationError("image too large (max 1 MB)");

      const cfg = getConfig();
      const dir = join(resolve(cfg.UPLOADS_DIR), "avatars");
      await mkdir(dir, { recursive: true });
      // Drop any prior avatar for this user (the extension may differ).
      await Promise.all(
        ["png", "jpg", "webp"].map((e) => rm(join(dir, `${userId}.${e}`), { force: true }).catch(() => {})),
      );
      await writeFile(join(dir, `${userId}.${ext}`), bytes);

      const v = createHash("sha1").update(bytes).digest("hex").slice(0, 10);
      const avatarUrl = `${cfg.APP_URL.replace(/\/$/, "")}/uploads/avatars/${userId}.${ext}?v=${v}`;
      const user = await prisma.user.update({ where: { id: userId }, data: { avatarUrl } });
      return { avatarUrl: user.avatarUrl };
    },
  );

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
