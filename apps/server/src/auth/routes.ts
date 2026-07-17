import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { Prisma } from "@prisma/client";
import { prisma } from "../db.js";
import { getConfig } from "../config.js";
import { hashPassword, verifyPassword } from "./password.js";
import { signSessionToken, signTwoFactorToken, verifyTwoFactorToken } from "./jwt.js";
import { requireAuth } from "./middleware.js";
import { AuthError, ConflictError, ValidationError } from "../errors.js";
import { buildOtpAuthUrl, buildQrDataUrl, generateTotpSecret, verifyTotpCode } from "./totp.js";
import { wrapAtRest, unwrapAtRest } from "../crypto-at-rest.js";
import { generateUniqueHandle } from "./handle-generator.js";

const registerBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(12, "password must be at least 12 characters"),
  displayName: z.string().min(1).max(50),
  // Base64-encoded X25519 public key (32 bytes raw → 44 chars base64).
  // Generated client-side via tweetnacl. Server stores as-is and never sees
  // the private half.
  e2eePublicKey: z.string().min(40).max(60).optional(),
});

const loginBodySchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export async function authRoutes(app: FastifyInstance): Promise<void> {
  app.post(
    "/auth/register",
    {
      config: {
        rateLimit: { max: 5, timeWindow: "1 hour" },
      },
    },
    async (request, reply) => {
      const parsed = registerBodySchema.safeParse(request.body);
      if (!parsed.success) {
        throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
      }
      const { email, password, displayName, e2eePublicKey } = parsed.data;
      const passwordHash = await hashPassword(password);
      const handle = await generateUniqueHandle(displayName);
      const handleLower = handle.toLowerCase();
      let user;
      try {
        user = await prisma.user.create({
          data: {
            email,
            displayName,
            passwordHash,
            handle,
            handleLower,
            ...(e2eePublicKey && { e2eePublicKey }),
          },
        });
      } catch (err) {
        // P2002 = Prisma unique-constraint violation (here: User.email)
        if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
          throw new ConflictError("email already registered");
        }
        throw err;
      }
      const session = await prisma.session.create({ data: { userId: user.id } });
      const token = signSessionToken(
        { userId: user.id, sessionId: session.id },
        getConfig().JWT_SECRET,
      );
      reply.status(201).send({
        token,
        user: { id: user.id, email: user.email, displayName: user.displayName, handle: user.handle ?? null, avatarUrl: user.avatarUrl ?? null, dndUntil: user.dndUntil?.toISOString() ?? null },
      });
    },
  );

  app.post("/auth/login", async (request, reply) => {
    const parsed = loginBodySchema.safeParse(request.body);
    if (!parsed.success) {
      throw new ValidationError("invalid input");
    }
    const { email, password } = parsed.data;

    const user = await prisma.user.findUnique({ where: { email } });
    if (!user) {
      throw new AuthError("invalid credentials");
    }
    const ok = await verifyPassword(password, user.passwordHash);
    if (!ok) {
      throw new AuthError("invalid credentials");
    }

    // 2FA gate: if enrolled, return a short-lived intent token instead of a session.
    if (user.totpEnabledAt && user.totpSecret) {
      const twoFactorToken = signTwoFactorToken(
        { userId: user.id, intent: "totp" },
        getConfig().JWT_SECRET,
      );
      reply.status(200).send({ requiresTotp: true, twoFactorToken });
      return;
    }

    const session = await prisma.session.create({ data: { userId: user.id } });
    const token = signSessionToken(
      { userId: user.id, sessionId: session.id },
      getConfig().JWT_SECRET,
    );
    reply.status(200).send({
      token,
      user: { id: user.id, email: user.email, displayName: user.displayName, handle: user.handle ?? null, avatarUrl: user.avatarUrl ?? null, dndUntil: user.dndUntil?.toISOString() ?? null },
    });
  });

  app.post(
    "/auth/login/totp",
    {
      config: { rateLimit: { max: 10, timeWindow: "1 minute" } },
    },
    async (request, reply) => {
      const parsed = totpVerifyBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid input");
      const { twoFactorToken, code } = parsed.data;

      let claims;
      try {
        claims = verifyTwoFactorToken(twoFactorToken, getConfig().JWT_SECRET);
      } catch {
        throw new AuthError("invalid or expired two-factor token");
      }
      const user = await prisma.user.findUnique({ where: { id: claims.userId } });
      if (!user || !user.totpSecret) throw new AuthError("invalid credentials");
      if (!verifyTotpCode(unwrapAtRest(user.totpSecret), code)) {
        throw new AuthError("invalid two-factor code");
      }

      const session = await prisma.session.create({ data: { userId: user.id } });
      const token = signSessionToken(
        { userId: user.id, sessionId: session.id },
        getConfig().JWT_SECRET,
      );
      reply.status(200).send({
        token,
        user: { id: user.id, email: user.email, displayName: user.displayName, handle: user.handle ?? null, avatarUrl: user.avatarUrl ?? null, dndUntil: user.dndUntil?.toISOString() ?? null },
      });
    },
  );

  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
    if (!user) throw new AuthError("user not found");
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

  // Public lookup endpoint: returns just the public key (or null) for sending
  // E2EE messages to a known user-id. No PII beyond what /me returns.
  app.get(
    "/users/:id/public-key",
    { preHandler: requireAuth },
    async (request) => {
      const id = (request.params as { id?: string }).id;
      if (!id) throw new ValidationError("missing id");
      const user = await prisma.user.findUnique({
        where: { id },
        select: { id: true, displayName: true, e2eePublicKey: true },
      });
      if (!user) throw new AuthError("user not found");
      return {
        id: user.id,
        displayName: user.displayName,
        publicKey: user.e2eePublicKey,
      };
    },
  );

  // Enroll/update the current user's E2EE public key. Used when a logged-in
  // user generates (or re-imports) their keypair on a new device.
  const setKeyBodySchema = z.object({
    e2eePublicKey: z.string().min(40).max(60),
  });
  app.post(
    "/auth/e2ee/public-key",
    { preHandler: requireAuth },
    async (request, reply) => {
      const parsed = setKeyBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid public key");
      await prisma.user.update({
        where: { id: request.auth!.userId },
        data: { e2eePublicKey: parsed.data.e2eePublicKey },
      });
      reply.status(204).send();
    },
  );

  app.post("/auth/logout", { preHandler: requireAuth }, async (request, reply) => {
    await prisma.session.update({
      where: { id: request.auth!.sessionId },
      data: { revokedAt: new Date() },
    });
    reply.status(204).send();
  });

  // 4.11 — active session list. IDs are opaque; createdAt + current flag is
  // all the UI needs to reason about "other devices".
  app.get("/auth/sessions", { preHandler: requireAuth }, async (request) => {
    const sessions = await prisma.session.findMany({
      where: { userId: request.auth!.userId, revokedAt: null },
      orderBy: { createdAt: "desc" },
      select: { id: true, createdAt: true },
    });
    return {
      sessions: sessions.map((s) => ({
        id: s.id,
        createdAt: s.createdAt.toISOString(),
        current: s.id === request.auth!.sessionId,
      })),
    };
  });

  // 4.11 — sign out everywhere: revokes every live session including this
  // one; the caller drops its token and lands on login.
  app.post("/auth/logout-all", { preHandler: requireAuth }, async (request, reply) => {
    await prisma.session.updateMany({
      where: { userId: request.auth!.userId, revokedAt: null },
      data: { revokedAt: new Date() },
    });
    reply.status(204).send();
  });

  // 2FA: start enrollment — generates a secret + QR. The secret is staged on the
  // user but `totpEnabledAt` stays null until enrollVerify confirms a working code.
  app.post(
    "/auth/2fa/enroll-start",
    { preHandler: requireAuth },
    async (request) => {
      const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
      if (!user) throw new AuthError("user not found");
      if (user.totpEnabledAt) {
        throw new ConflictError("2FA already enabled — disable first to re-enroll");
      }
      const secret = generateTotpSecret();
      await prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: wrapAtRest(secret) },
      });
      const otpAuthUrl = buildOtpAuthUrl(user.email, secret);
      const qrDataUrl = await buildQrDataUrl(otpAuthUrl);
      return { secret, otpAuthUrl, qrDataUrl };
    },
  );

  app.post(
    "/auth/2fa/enroll-verify",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = totpEnrollVerifyBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid input");
      const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
      if (!user || !user.totpSecret) throw new AuthError("no enrollment in progress");
      if (!verifyTotpCode(unwrapAtRest(user.totpSecret), parsed.data.code)) {
        throw new AuthError("invalid two-factor code");
      }
      await prisma.user.update({
        where: { id: user.id },
        data: { totpEnabledAt: new Date() },
      });
      return { enabled: true };
    },
  );

  app.post(
    "/auth/2fa/disable",
    { preHandler: requireAuth },
    async (request) => {
      const parsed = totpDisableBodySchema.safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid input");
      const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
      if (!user) throw new AuthError("user not found");
      const ok = await verifyPassword(parsed.data.password, user.passwordHash);
      if (!ok) throw new AuthError("invalid password");
      await prisma.user.update({
        where: { id: user.id },
        data: { totpSecret: null, totpEnabledAt: null },
      });
      return { enabled: false };
    },
  );
}

const totpVerifyBodySchema = z.object({
  twoFactorToken: z.string().min(1),
  code: z.string().min(6).max(8),
});

const totpEnrollVerifyBodySchema = z.object({
  code: z.string().min(6).max(8),
});

const totpDisableBodySchema = z.object({
  password: z.string().min(1),
});
