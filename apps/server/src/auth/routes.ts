import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { createHash, randomBytes as cryptoRandomBytes } from "node:crypto";
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
import { emailEnabled, sendMail } from "../email/mailer.js";
import { verifyEmail, passwordResetEmail, verifyResultPage } from "../email/templates.js";
import { issueEmailToken, consumeEmailToken } from "../email/tokens.js";

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

interface AuthUserRow {
  id: string;
  email: string;
  displayName: string;
  handle: string | null;
  avatarUrl: string | null;
  dndUntil: Date | null;
  emailVerifiedAt: Date | null;
}

function toAuthUser(u: AuthUserRow): Record<string, unknown> {
  return {
    id: u.id,
    email: u.email,
    displayName: u.displayName,
    handle: u.handle ?? null,
    avatarUrl: u.avatarUrl ?? null,
    dndUntil: u.dndUntil?.toISOString() ?? null,
    // When email is off, everyone is implicitly verified (no gate to satisfy).
    emailVerified: !emailEnabled() || u.emailVerifiedAt !== null,
  };
}

/** Fire-and-forget verify email so registration latency isn't mail-bound. */
async function sendVerification(user: { id: string; email: string; displayName: string }): Promise<void> {
  if (!emailEnabled()) return;
  const raw = await issueEmailToken(user.id, "verify");
  const link = `${getConfig().APP_URL}/auth/verify-email?token=${encodeURIComponent(raw)}`;
  const mail = verifyEmail(user.displayName, link);
  await sendMail({ to: user.email, ...mail });
}

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
            // Email off → auto-verified; on → null until the link is clicked.
            emailVerifiedAt: emailEnabled() ? null : new Date(),
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
      // Best-effort: a mail hiccup must not fail registration (the user can
      // resend from the gate). Awaited so token creation is ordered, but errors
      // are swallowed.
      try {
        await sendVerification(user);
      } catch (err) {
        app.log.error({ err }, "verification email send failed");
      }
      const session = await prisma.session.create({ data: { userId: user.id } });
      const token = signSessionToken(
        { userId: user.id, sessionId: session.id },
        getConfig().JWT_SECRET,
      );
      reply.status(201).send({ token, user: toAuthUser(user) });
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
    reply.status(200).send({ token, user: toAuthUser(user) });
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
      // Accept either a live TOTP code or an unused backup code (3.3b).
      const totpOk = verifyTotpCode(unwrapAtRest(user.totpSecret), code);
      if (!totpOk) {
        const burned = await consumeBackupCode(user.id, code);
        if (!burned) throw new AuthError("invalid two-factor code");
      }

      const session = await prisma.session.create({ data: { userId: user.id } });
      const token = signSessionToken(
        { userId: user.id, sessionId: session.id },
        getConfig().JWT_SECRET,
      );
      reply.status(200).send({ token, user: toAuthUser(user) });
    },
  );

  app.get("/me", { preHandler: requireAuth }, async (request) => {
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
    if (!user) throw new AuthError("user not found");
    return {
      ...toAuthUser(user),
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
      // 3.3b — one-time backup codes, returned exactly once here.
      const backupCodes = await issueBackupCodes(user.id);
      return { enabled: true, backupCodes };
    },
  );

  // Regenerate backup codes (invalidates all previous ones). Password-gated.
  app.post("/auth/2fa/backup-codes", { preHandler: requireAuth }, async (request) => {
    const parsed = totpDisableBodySchema.safeParse(request.body);
    if (!parsed.success) throw new ValidationError("invalid input");
    const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
    if (!user || user.totpEnabledAt === null) throw new AuthError("2FA is not enabled");
    const ok = await verifyPassword(parsed.data.password, user.passwordHash);
    if (!ok) throw new AuthError("invalid password");
    const backupCodes = await issueBackupCodes(user.id);
    return { backupCodes };
  });

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

  // ---------------------------------------------------------------------
  // Email verification (WireFrames 1.5)
  // ---------------------------------------------------------------------

  // Clicked from the emailed link — returns an HTML page, not JSON. Always
  // 200 so the browser renders our result page (success or expired) rather
  // than a bare error.
  app.get<{ Querystring: { token?: string } }>("/auth/verify-email", async (request, reply) => {
    const raw = request.query.token;
    const userId = raw ? await consumeEmailToken(raw, "verify") : null;
    if (userId) {
      await prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } });
    }
    reply.type("text/html").send(verifyResultPage(Boolean(userId)));
  });

  // Resend the verification email to the signed-in user (rate-limited).
  app.post(
    "/auth/verify-email/resend",
    { preHandler: requireAuth, config: { rateLimit: { max: 3, timeWindow: "10 minutes" } } },
    async (request, reply) => {
      const user = await prisma.user.findUnique({ where: { id: request.auth!.userId } });
      if (!user) throw new AuthError("user not found");
      if (!emailEnabled() || user.emailVerifiedAt) {
        // Nothing to do — idempotent success.
        reply.status(204).send();
        return;
      }
      try {
        await sendVerification(user);
      } catch (err) {
        app.log.error({ err }, "verification resend failed");
      }
      reply.status(204).send();
    },
  );

  // ---------------------------------------------------------------------
  // Password reset (WireFrames 1.6 request → 1.7 form)
  // ---------------------------------------------------------------------

  // Request a reset link. ALWAYS 204 regardless of whether the email exists —
  // no account enumeration. Only fires mail when email is configured.
  app.post(
    "/auth/password-reset/request",
    { config: { rateLimit: { max: 5, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const parsed = z.object({ email: z.string().email() }).safeParse(request.body);
      if (!parsed.success) throw new ValidationError("invalid email");
      if (emailEnabled()) {
        const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
        if (user) {
          try {
            const raw = await issueEmailToken(user.id, "reset");
            const link = `${getConfig().APP_URL}/reset?token=${encodeURIComponent(raw)}`;
            const mail = passwordResetEmail(user.displayName, link);
            await sendMail({ to: user.email, ...mail });
          } catch (err) {
            app.log.error({ err }, "password reset email failed");
          }
        }
      }
      reply.status(204).send();
    },
  );

  // Confirm a reset: validate the token, set the new password, burn every
  // session (a reset implies the account may be compromised).
  app.post(
    "/auth/password-reset/confirm",
    { config: { rateLimit: { max: 10, timeWindow: "15 minutes" } } },
    async (request, reply) => {
      const parsed = z
        .object({ token: z.string().min(1), password: z.string().min(12, "password must be at least 12 characters") })
        .safeParse(request.body);
      if (!parsed.success) throw new ValidationError(parsed.error.issues[0]?.message ?? "invalid input");
      const userId = await consumeEmailToken(parsed.data.token, "reset");
      if (!userId) throw new ValidationError("this reset link is invalid or has expired");
      const passwordHash = await hashPassword(parsed.data.password);
      await prisma.$transaction([
        prisma.user.update({ where: { id: userId }, data: { passwordHash } }),
        // Resetting the password also confirms control of the inbox.
        prisma.user.update({ where: { id: userId }, data: { emailVerifiedAt: new Date() } }),
        prisma.session.deleteMany({ where: { userId } }),
      ]);
      reply.status(204).send();
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

// ── 2FA backup codes (3.3b) ─────────────────────────────────────────────
// Format XXXX-XXXX from an unambiguous alphabet; only sha256 hashes at
// rest; consuming marks usedAt so each code works exactly once.
const BACKUP_ALPHABET = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";

function makeBackupCode(): string {
  const bytes = cryptoRandomBytes(8);
  let out = "";
  for (let i = 0; i < 8; i++) {
    out += BACKUP_ALPHABET[bytes[i]! % BACKUP_ALPHABET.length];
    if (i === 3) out += "-";
  }
  return out;
}

function hashBackupCode(code: string): string {
  return createHash("sha256").update(code.toUpperCase().replace(/[^A-Z0-9]/g, "")).digest("hex");
}

async function issueBackupCodes(userId: string): Promise<string[]> {
  const codes = Array.from({ length: 10 }, makeBackupCode);
  await prisma.$transaction([
    prisma.totpBackupCode.deleteMany({ where: { userId } }),
    prisma.totpBackupCode.createMany({
      data: codes.map((c) => ({ userId, codeHash: hashBackupCode(c) })),
    }),
  ]);
  return codes;
}

async function consumeBackupCode(userId: string, code: string): Promise<boolean> {
  const cleaned = code.toUpperCase().replace(/[^A-Z0-9]/g, "");
  if (cleaned.length !== 8) return false;
  const hash = hashBackupCode(cleaned);
  const row = await prisma.totpBackupCode.findFirst({
    where: { userId, codeHash: hash, usedAt: null },
  });
  if (!row) return false;
  await prisma.totpBackupCode.update({ where: { id: row.id }, data: { usedAt: new Date() } });
  return true;
}
