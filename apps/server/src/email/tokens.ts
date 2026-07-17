import { createHash, randomBytes } from "node:crypto";
import { prisma } from "../db.js";

// Raw token = 32 random bytes, base64url. Only its sha256 hash is persisted,
// so a leaked DB can't be used to forge links. The raw value travels only in
// the emailed URL.
export type EmailTokenKind = "verify" | "reset";

const TTL_MS: Record<EmailTokenKind, number> = {
  verify: 24 * 3_600_000,
  reset: 3_600_000,
};

function hash(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/** Mint a token for a user, invalidating any prior unused token of the same kind. */
export async function issueEmailToken(userId: string, kind: EmailTokenKind): Promise<string> {
  const raw = randomBytes(32).toString("base64url");
  await prisma.$transaction([
    prisma.emailToken.deleteMany({ where: { userId, kind, usedAt: null } }),
    prisma.emailToken.create({
      data: {
        userId,
        kind,
        tokenHash: hash(raw),
        expiresAt: new Date(Date.now() + TTL_MS[kind]),
      },
    }),
  ]);
  return raw;
}

/**
 * Validate + burn a token. Returns the userId on success, null if the token is
 * unknown, wrong-kind, expired, or already used. Consumption is atomic via a
 * conditional updateMany so a token can't be redeemed twice concurrently.
 */
export async function consumeEmailToken(raw: string, kind: EmailTokenKind): Promise<string | null> {
  const row = await prisma.emailToken.findUnique({ where: { tokenHash: hash(raw) } });
  if (!row || row.kind !== kind || row.usedAt !== null || row.expiresAt.getTime() < Date.now()) {
    return null;
  }
  const burned = await prisma.emailToken.updateMany({
    where: { id: row.id, usedAt: null },
    data: { usedAt: new Date() },
  });
  return burned.count === 1 ? row.userId : null;
}
