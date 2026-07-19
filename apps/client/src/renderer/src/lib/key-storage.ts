import { generateKeyPair, isPlausibleKey, type KeyPair } from "./crypto.js";

// Base (unnamespaced) keys. These now double as a one-shot "staging" slot:
// keypairs from pre-namespacing builds AND login-screen restores land here, and
// the next successful login CLAIMS the staged pair into that user's own
// namespace, then clears staging.
const SECRET_KEY_LS = "r3dvoice.e2ee.secretKey";
const PUBLIC_KEY_LS = "r3dvoice.e2ee.publicKey";

/**
 * Per-USER E2EE keypair store. The keypair is keyed by user id, not shared
 * device-wide - otherwise a second account signing in on the same device would
 * inherit (and could decrypt with) the first user's crypto identity. auth-store
 * calls setActiveKeyUser() on every login/hydrate; load/save/clear operate only
 * on that user's slot and no-op when logged out.
 *
 * The secret key NEVER leaves the device unless explicitly exported via
 * downloadKeyBackup. The public key is uploaded to the server at registration.
 */
let activeUserId: string | null = null;

/** Scope subsequent key reads/writes to a user (or null when logged out). */
export function setActiveKeyUser(userId: string | null): void {
  activeUserId = userId;
}

function nsKey(base: string, userId: string): string {
  return `${base}::${userId}`;
}

// Move a staged (unnamespaced) keypair into a user's namespace and burn the
// staging slot - so a staged key is claimable exactly once, by the first user
// to sign in after it was staged.
function claimStagedFor(userId: string): boolean {
  const ls = globalThis.localStorage;
  if (!ls) return false;
  const s = ls.getItem(SECRET_KEY_LS);
  const p = ls.getItem(PUBLIC_KEY_LS);
  if (!s || !p) return false;
  ls.setItem(nsKey(SECRET_KEY_LS, userId), s);
  ls.setItem(nsKey(PUBLIC_KEY_LS, userId), p);
  ls.removeItem(SECRET_KEY_LS);
  ls.removeItem(PUBLIC_KEY_LS);
  return true;
}

export function loadKeyPair(): KeyPair | null {
  if (!activeUserId) return null;
  const ls = globalThis.localStorage;
  if (!ls) return null;
  try {
    let sk = ls.getItem(nsKey(SECRET_KEY_LS, activeUserId));
    let pk = ls.getItem(nsKey(PUBLIC_KEY_LS, activeUserId));
    // First read after login with an empty namespace: adopt a staged key
    // (legacy pre-namespacing key, or a login-screen restore) into this user.
    if ((!sk || !pk) && claimStagedFor(activeUserId)) {
      sk = ls.getItem(nsKey(SECRET_KEY_LS, activeUserId));
      pk = ls.getItem(nsKey(PUBLIC_KEY_LS, activeUserId));
    }
    if (!sk || !pk) return null;
    if (!isPlausibleKey(sk) || !isPlausibleKey(pk)) return null;
    return { publicKey: pk, secretKey: sk };
  } catch {
    return null;
  }
}

export function saveKeyPair(kp: KeyPair): void {
  if (!activeUserId) return;
  globalThis.localStorage?.setItem(nsKey(SECRET_KEY_LS, activeUserId), kp.secretKey);
  globalThis.localStorage?.setItem(nsKey(PUBLIC_KEY_LS, activeUserId), kp.publicKey);
}

export function clearKeyPair(): void {
  if (!activeUserId) return;
  globalThis.localStorage?.removeItem(nsKey(SECRET_KEY_LS, activeUserId));
  globalThis.localStorage?.removeItem(nsKey(PUBLIC_KEY_LS, activeUserId));
}

/**
 * Stage a keypair BEFORE login (the login-screen "Restore E2EE key backup"
 * flow, which runs while logged out). It lands in the shared staging slot and
 * is claimed into the user's namespace the moment they sign in.
 */
export function stageRestoredKeyPair(kp: KeyPair): void {
  const ls = globalThis.localStorage;
  if (!ls) return;
  ls.setItem(SECRET_KEY_LS, kp.secretKey);
  ls.setItem(PUBLIC_KEY_LS, kp.publicKey);
}

/**
 * Generate + persist a fresh keypair for the active user. Returns the new pair
 * so the caller can upload the public half to the server.
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
 * The user is encouraged to save this somewhere safe - losing it means
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
