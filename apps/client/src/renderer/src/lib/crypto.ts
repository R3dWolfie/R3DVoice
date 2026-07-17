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
