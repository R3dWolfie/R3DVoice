import { safeStorage, app } from "electron";
import { promises as fs } from "node:fs";
import { join } from "node:path";

const FILENAME = "session.enc";
// Plaintext fallback for systems with no OS keyring (common on minimal Linux
// without gnome-keyring/kwallet, where safeStorage.isEncryptionAvailable() is
// false). Without this the app was UNUSABLE there - login succeeded on the
// server but saveToken threw, surfacing as "Incorrect email or password".
const PLAIN_FILENAME = "session.token";

function tokenPath(): string {
  return join(app.getPath("userData"), FILENAME);
}
function plainTokenPath(): string {
  return join(app.getPath("userData"), PLAIN_FILENAME);
}

export async function saveToken(token: string): Promise<void> {
  if (safeStorage.isEncryptionAvailable()) {
    const encrypted = safeStorage.encryptString(token);
    await fs.writeFile(tokenPath(), encrypted, { mode: 0o600 });
    // writeFile's mode only applies on CREATE - enforce 0600 on overwrite too.
    await fs.chmod(tokenPath(), 0o600).catch(() => {});
    // Drop any stale plaintext fallback once encryption is available again.
    await fs.rm(plainTokenPath(), { force: true }).catch(() => {});
    return;
  }
  // No keyring: persist to a user-private (0600) plaintext file. The value is
  // a short-lived session JWT (not a password) and userData is per-user, so
  // this is an acceptable degraded mode - the alternative is a broken app.
  await fs.writeFile(plainTokenPath(), token, { mode: 0o600 });
  await fs.chmod(plainTokenPath(), 0o600).catch(() => {});
  // Drop any stale ENCRYPTED token: getToken prefers session.enc whenever
  // encryption is available, so a leftover blob would decrypt an old/revoked
  // token later and force a spurious logout.
  await fs.rm(tokenPath(), { force: true }).catch(() => {});
}

export async function getToken(): Promise<string | null> {
  // Prefer the encrypted store; fall back to the plaintext file.
  try {
    const bytes = await fs.readFile(tokenPath());
    if (safeStorage.isEncryptionAvailable()) return safeStorage.decryptString(bytes);
  } catch {
    /* fall through to plaintext */
  }
  try {
    const plain = await fs.readFile(plainTokenPath(), "utf8");
    return plain.trim() || null;
  } catch {
    return null;
  }
}

export async function clearToken(): Promise<void> {
  await fs.rm(tokenPath(), { force: true });
  await fs.rm(plainTokenPath(), { force: true });
}
