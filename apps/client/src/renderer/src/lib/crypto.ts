import nacl from "tweetnacl";
import naclUtil from "tweetnacl-util";

/**
 * E2EE primitives for DM messages, built on NaCl box (Curve25519 + XSalsa20-
 * Poly1305) via tweetnacl. Server stores ciphertext only — it never sees
 * private keys.
 *
 * Sender → recipient: nacl.box(plaintext, nonce, recipientPublicKey, senderSecretKey)
 * Recipient: nacl.box.open(ciphertext, nonce, senderPublicKey, recipientSecretKey)
 *
 * Wire format for one DM body:
 *   {
 *     v: 1,
 *     n: <base64 24-byte nonce>,
 *     c: <base64 ciphertext>,
 *     s: <base64 sender public key — so recipient can decrypt>,
 *   }
 *
 * The sender public key is included so the recipient doesn't need to look it
 * up. Tradeoff: a server log of (recipient, sender, ciphertext-size) is
 * already metadata-leaky; the public key adds no privacy loss.
 */

export interface KeyPair {
  /** Base64 X25519 public key (32 bytes). */
  publicKey: string;
  /** Base64 X25519 secret key (32 bytes). */
  secretKey: string;
}

export interface EncryptedDMPayload {
  v: 1;
  n: string;
  c: string;
  s: string;
}

/** Derive the X25519 public key from a secret key (base64 in/out). */
export function publicKeyFromSecret(secretKeyB64: string): string {
  const kp = nacl.box.keyPair.fromSecretKey(naclUtil.decodeBase64(secretKeyB64));
  return naclUtil.encodeBase64(kp.publicKey);
}

export function generateKeyPair(): KeyPair {
  const kp = nacl.box.keyPair();
  return {
    publicKey: naclUtil.encodeBase64(kp.publicKey),
    secretKey: naclUtil.encodeBase64(kp.secretKey),
  };
}

export function encryptDM(
  plaintext: string,
  recipientPublicKey: string,
  senderKeyPair: KeyPair,
): EncryptedDMPayload {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const message = naclUtil.decodeUTF8(plaintext);
  const recipientPub = naclUtil.decodeBase64(recipientPublicKey);
  const senderSec = naclUtil.decodeBase64(senderKeyPair.secretKey);
  const ciphertext = nacl.box(message, nonce, recipientPub, senderSec);
  return {
    v: 1,
    n: naclUtil.encodeBase64(nonce),
    c: naclUtil.encodeBase64(ciphertext),
    s: senderKeyPair.publicKey,
  };
}

export function decryptDM(
  payload: EncryptedDMPayload,
  recipientKeyPair: KeyPair,
  /**
   * The OTHER participant's public key. Required to decrypt messages you
   * authored: box's shared secret is ECDH(myPriv, otherPub), and for your
   * own envelopes payload.s is your own key — using it would compute
   * ECDH(me, me) and always fail. NaCl box is symmetric, so opening with
   * (counterpartyPub, mySec) works for both directions.
   */
  counterpartyPublicKey?: string,
): string | null {
  try {
    if (payload.v !== 1) return null;
    const nonce = naclUtil.decodeBase64(payload.n);
    const ciphertext = naclUtil.decodeBase64(payload.c);
    const iAmSender = payload.s === recipientKeyPair.publicKey;
    const otherPubB64 = iAmSender && counterpartyPublicKey ? counterpartyPublicKey : payload.s;
    const otherPub = naclUtil.decodeBase64(otherPubB64);
    const recipientSec = naclUtil.decodeBase64(recipientKeyPair.secretKey);
    const plain = nacl.box.open(ciphertext, nonce, otherPub, recipientSec);
    if (!plain) return null;
    return naclUtil.encodeUTF8(plain);
  } catch {
    return null;
  }
}

/**
 * Generic byte-level NaCl box wrapper. Used by room-e2ee.ts to ferry the
 * room SFrame key between participants without surfacing the bytes to the
 * server. Wire format mirrors EncryptedDMPayload.
 */
export interface EncryptedBytes {
  v: 1;
  n: string;
  c: string;
  s: string;
}

export function encryptBytes(
  plaintext: Uint8Array,
  recipientPublicKey: string,
  senderKeyPair: KeyPair,
): EncryptedBytes {
  const nonce = nacl.randomBytes(nacl.box.nonceLength);
  const recipientPub = naclUtil.decodeBase64(recipientPublicKey);
  const senderSec = naclUtil.decodeBase64(senderKeyPair.secretKey);
  const ciphertext = nacl.box(plaintext, nonce, recipientPub, senderSec);
  return {
    v: 1,
    n: naclUtil.encodeBase64(nonce),
    c: naclUtil.encodeBase64(ciphertext),
    s: senderKeyPair.publicKey,
  };
}

export function decryptBytes(
  payload: EncryptedBytes,
  recipientKeyPair: KeyPair,
): Uint8Array | null {
  try {
    if (payload.v !== 1) return null;
    const nonce = naclUtil.decodeBase64(payload.n);
    const ciphertext = naclUtil.decodeBase64(payload.c);
    const senderPub = naclUtil.decodeBase64(payload.s);
    const recipientSec = naclUtil.decodeBase64(recipientKeyPair.secretKey);
    return nacl.box.open(ciphertext, nonce, senderPub, recipientSec);
  } catch {
    return null;
  }
}

/** True if `s` looks like a valid base64-encoded 32-byte key (44 chars). */
export function isPlausibleKey(s: string): boolean {
  if (typeof s !== "string") return false;
  if (s.length < 40 || s.length > 60) return false;
  try {
    const bytes = naclUtil.decodeBase64(s);
    return bytes.length === 32;
  } catch {
    return false;
  }
}

// ── Password-synced key escrow (hybrid E2EE) ───────────────────────────────
// To make DMs readable across devices without giving up E2EE, the user's
// secret key is wrapped (encrypted) with a key derived from their PASSWORD and
// stored server-side. The server never sees the password (only its hash) nor
// the derived key nor the plaintext secret key — only the wrapped blob. On
// login (on any device) the client fetches the blob and unwraps it with the
// password it already has in hand. Threat model: resistant to a passive /
// honest-but-curious server (it cannot read DMs), NOT to a server that
// actively captures the password at login — an accepted tradeoff for usability.

export interface WrappedSecretKey {
  wrapped: string; // base64 secretbox ciphertext of the 32-byte secret key
  salt: string; // base64 PBKDF2 salt
  nonce: string; // base64 secretbox nonce
}

const KDF_ITERATIONS = 210_000;

async function deriveWrapKey(password: string, salt: Uint8Array): Promise<Uint8Array> {
  const baseKey = await crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(password),
    "PBKDF2",
    false,
    ["deriveBits"],
  );
  const bits = await crypto.subtle.deriveBits(
    { name: "PBKDF2", salt: salt as BufferSource, iterations: KDF_ITERATIONS, hash: "SHA-256" },
    baseKey,
    256, // 32 bytes → nacl.secretbox key length
  );
  return new Uint8Array(bits);
}

/** Encrypt a secret key with a password-derived key (for server escrow). */
export async function wrapSecretKey(secretKeyB64: string, password: string): Promise<WrappedSecretKey> {
  const salt = nacl.randomBytes(16);
  const nonce = nacl.randomBytes(nacl.secretbox.nonceLength);
  const key = await deriveWrapKey(password, salt);
  const box = nacl.secretbox(naclUtil.decodeBase64(secretKeyB64), nonce, key);
  return {
    wrapped: naclUtil.encodeBase64(box),
    salt: naclUtil.encodeBase64(salt),
    nonce: naclUtil.encodeBase64(nonce),
  };
}

/** Decrypt a wrapped secret key with the password. Returns null on wrong password. */
export async function unwrapSecretKey(w: WrappedSecretKey, password: string): Promise<string | null> {
  try {
    const key = await deriveWrapKey(password, naclUtil.decodeBase64(w.salt));
    const sk = nacl.secretbox.open(naclUtil.decodeBase64(w.wrapped), naclUtil.decodeBase64(w.nonce), key);
    return sk ? naclUtil.encodeBase64(sk) : null;
  } catch {
    return null;
  }
}
