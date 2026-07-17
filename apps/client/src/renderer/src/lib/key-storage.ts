import { generateKeyPair, isPlausibleKey, type KeyPair } from "./crypto.js";

const SECRET_KEY_LS = "r3dvoice.e2ee.secretKey";
const PUBLIC_KEY_LS = "r3dvoice.e2ee.publicKey";

/**
 * Per-user E2EE keypair store. We keep the keys in localStorage for now —
 * an Electron renderer's localStorage is process-private to this app, and
 * the JWT is already there too. Future hardening: wrap the secret key in
 * Electron safeStorage (OS keychain) via IPC. For now: simple, working.
 *
 * The secret key NEVER leaves the user's device unless explicitly exported
 * via `exportKeyBackup`. The public key is uploaded to the server during
 * registration.
 */

export function loadKeyPair(): KeyPair | null {
  try {
    const sk = globalThis.localStorage?.getItem(SECRET_KEY_LS);
    const pk = globalThis.localStorage?.getItem(PUBLIC_KEY_LS);
    if (!sk || !pk) return null;
    if (!isPlausibleKey(sk) || !isPlausibleKey(pk)) return null;
    return { publicKey: pk, secretKey: sk };
  } catch {
    return null;
  }
}

export function saveKeyPair(kp: KeyPair): void {
  globalThis.localStorage?.setItem(SECRET_KEY_LS, kp.secretKey);
  globalThis.localStorage?.setItem(PUBLIC_KEY_LS, kp.publicKey);
}

export function clearKeyPair(): void {
  globalThis.localStorage?.removeItem(SECRET_KEY_LS);
  globalThis.localStorage?.removeItem(PUBLIC_KEY_LS);
}

/**
 * Generate + persist a fresh keypair. Returns the new pair so the caller
 * can immediately upload the public half to the server.
 */
export function ensureKeyPair(): KeyPair {
  const existing = loadKeyPair();
  if (existing) return existing;
  const fresh = generateKeyPair();
  saveKeyPair(fresh);
  return fresh;
}

/**
 * Build a JSON backup blob containing the keypair + identity metadata.
 * The user is encouraged to save this somewhere safe — losing it means
 * losing access to encrypted DM history.
 */
export interface KeyBackup {
  v: 1;
  r3dvoice: "e2ee-key-backup";
  email: string;
  publicKey: string;
  secretKey: string;
  exportedAt: string;
}

export function buildKeyBackup(email: string, kp: KeyPair): KeyBackup {
  return {
    v: 1,
    r3dvoice: "e2ee-key-backup",
    email,
    publicKey: kp.publicKey,
    secretKey: kp.secretKey,
    exportedAt: new Date().toISOString(),
  };
}

export function downloadKeyBackup(email: string, kp: KeyPair): void {
  const blob = new Blob([JSON.stringify(buildKeyBackup(email, kp), null, 2)], {
    type: "application/json",
  });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = `r3dvoice-key-${email.replace(/[^a-z0-9]+/gi, "-")}.json`;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function parseKeyBackup(json: string): KeyPair | null {
  try {
    const parsed: unknown = JSON.parse(json);
    if (typeof parsed !== "object" || parsed === null) return null;
    const obj = parsed as Record<string, unknown>;
    if (obj.r3dvoice !== "e2ee-key-backup") return null;
    if (typeof obj.publicKey !== "string" || typeof obj.secretKey !== "string") return null;
    if (!isPlausibleKey(obj.publicKey) || !isPlausibleKey(obj.secretKey)) return null;
    return { publicKey: obj.publicKey, secretKey: obj.secretKey };
  } catch {
    return null;
  }
}
