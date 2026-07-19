import { randomBytes, createCipheriv, createDecipheriv, createHash } from "node:crypto";

/**
 * Application-layer at-rest encryption for sensitive columns (TOTP secrets,
 * room chat bodies). DMs are NOT touched here - they're already client-side
 * E2EE ciphertext envelopes the server can't read either way.
 *
 * Wire format: `enc:v1:<iv-b64>:<ciphertext+tag-b64>`. The "enc:v1:" prefix
 * lets old plaintext rows continue to round-trip readably during migration -
 * unwrapAtRest returns plaintext input as-is.
 *
 * Key source: process.env.MASTER_KEY (>=32 chars). Hashed with SHA-256 to
 * produce a 32-byte AES-256 key. If missing, encryption is a no-op + a
 * warning is logged at startup. This keeps tests + dev environments
 * working without forcing operators through key generation.
 */

const PREFIX = "enc:v1:";
const IV_LEN = 12; // GCM standard
let cachedKey: Buffer | null = null;
let warned = false;

function getKey(): Buffer | null {
  if (cachedKey !== null) return cachedKey;
  const raw = process.env["MASTER_KEY"];
  if (!raw || raw.length < 32) {
    if (!warned) {
      // eslint-disable-next-line no-console
      console.warn(
        "[crypto-at-rest] MASTER_KEY missing or <32 chars; sensitive columns stored as plaintext. " +
          "Set MASTER_KEY to enable at-rest encryption.",
      );
      warned = true;
    }
    return null;
  }
  cachedKey = createHash("sha256").update(raw).digest();
  return cachedKey;
}

export function wrapAtRest(plaintext: string): string {
  const key = getKey();
  if (!key) return plaintext;
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([enc, tag]).toString("base64");
  return `${PREFIX}${iv.toString("base64")}:${blob}`;
}

export function unwrapAtRest(stored: string): string {
  if (!stored.startsWith(PREFIX)) return stored; // legacy plaintext or non-encrypted
  const key = getKey();
  if (!key) {
    throw new Error("ciphertext stored but MASTER_KEY missing - cannot decrypt");
  }
  const rest = stored.slice(PREFIX.length);
  const colon = rest.indexOf(":");
  if (colon < 0) throw new Error("malformed ciphertext: no separator");
  const iv = Buffer.from(rest.slice(0, colon), "base64");
  const blob = Buffer.from(rest.slice(colon + 1), "base64");
  if (blob.length < 16) throw new Error("malformed ciphertext: too short");
  const tag = blob.subarray(blob.length - 16);
  const enc = blob.subarray(0, blob.length - 16);
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(enc), decipher.final()]);
  return plain.toString("utf8");
}

/** True if `s` looks like a stored at-rest ciphertext envelope. */
export function isWrapped(s: string): boolean {
  return typeof s === "string" && s.startsWith(PREFIX);
}

/** Test-only reset - flushes the cached key so MASTER_KEY changes mid-test. */
export function __resetCryptoForTests(): void {
  cachedKey = null;
  warned = false;
}
