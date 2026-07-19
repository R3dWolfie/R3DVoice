import { createStore, type StoreApi } from "zustand/vanilla";
import type { UserDTO } from "@r3dvoice/shared";
import { ApiClient, ApiError } from "./api.js";
import { downloadKeyBackup, loadKeyPair, saveKeyPair, setActiveKeyUser } from "./key-storage.js";
import { wrapSecretKey, unwrapSecretKey, publicKeyFromSecret, generateKeyPair } from "./crypto.js";
import { useUnreadStore } from "./unread-store.js";

export interface AuthStorageAdapter {
  saveToken(token: string): Promise<void>;
  getToken(): Promise<string | null>;
  clearToken(): Promise<void>;
}

type AuthStatus = "unauthenticated" | "loading" | "totp-required" | "authenticated";

export interface AuthState {
  status: AuthStatus;
  user: UserDTO | null;
  token: string | null;
  serverUrl: string;
  error: string | null;
  /** Short-lived JWT issued by /auth/login when 2FA is enabled. Sent to /auth/login/totp. */
  twoFactorToken: string | null;

  login(email: string, password: string): Promise<void>;
  loginTotp(code: string): Promise<void>;
  cancelTotp(): void;
  register(email: string, password: string, displayName: string): Promise<void>;
  logout(): Promise<void>;
  hydrate(): Promise<void>;
  /** Re-fetch /me and update the user slot. Used after 2FA toggles, profile edits, etc. */
  refreshUser(): Promise<void>;
  updateAvatarUrl(url: string | null): Promise<void>;
  setServerUrl(url: string): void;
}

const DEFAULT_SERVER_URL = "https://voice.r3dwolfie.com";


/**
 * Hybrid E2EE key sync: make the user's DM key available on every device via
 * their password (escrow). Called after each successful auth with the plaintext
 * password (which the client already has in hand at that moment).
 *  - Local key present, server has none → escrow it (backfill / first device).
 *  - No local key, server has an escrow blob → unwrap with the password and
 *    install it, so DMs are immediately readable on this new device.
 *  - No local key, no escrow → legacy account; user restores from file.
 * Best-effort: never throws into the auth flow.
 */
async function syncE2eeKey(api: ApiClient, password: string): Promise<void> {
  try {
    const local = loadKeyPair();
    const remote = await api.getWrappedKey();
    if (local) {
      if (!remote.wrapped) {
        await api.putWrappedKey(await wrapSecretKey(local.secretKey, password));
      }
      return;
    }
    if (remote.wrapped && remote.salt && remote.nonce) {
      const secretKey = await unwrapSecretKey(
        { wrapped: remote.wrapped, salt: remote.salt, nonce: remote.nonce },
        password,
      );
      if (secretKey) {
        saveKeyPair({ secretKey, publicKey: publicKeyFromSecret(secretKey) });
      } else {
        // An escrow blob exists but wouldn't unwrap - most likely it's still
        // wrapped under a password that changed (e.g. after a reset). Surface
        // it instead of silently leaving DMs unreadable; the in-DM "restore
        // your key" banner is the recovery path.
        // eslint-disable-next-line no-console
        console.warn(
          "[auth] e2ee escrow present but could not be unwrapped with this password (stale after a password change?)",
        );
      }
    }
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn("[auth] e2ee key sync failed:", err);
  }
}

// Transient password stash for the TOTP two-step (loginTotp has no password of
// its own but still needs it to unwrap the escrowed key). Module-scoped, never
// persisted, cleared right after use.
let pendingTotpPassword: string | null = null;

export function createAuthStore(
  api: ApiClient,
  storage: AuthStorageAdapter,
): StoreApi<AuthState> {
  return createStore<AuthState>((set, get) => ({
    status: "unauthenticated",
    user: null,
    token: null,
    twoFactorToken: null,
    serverUrl: DEFAULT_SERVER_URL,
    error: null,

    async login(email, password) {
      set({ status: "loading", error: null, twoFactorToken: null });
      try {
        const res = await api.login({ email, password });
        if ("requiresTotp" in res) {
          pendingTotpPassword = password;
          set({ status: "totp-required", twoFactorToken: res.twoFactorToken, error: null });
          return;
        }
        const { token, user } = res;
        api.setToken(token);
        // Scope E2EE keys to this user before touching them (per-device key
        // isolation - a different account must not inherit this one's key).
        setActiveKeyUser(user.id);
        await syncE2eeKey(api, password);
        // Persisting the session must never fail the login: on Linux without a
        // keyring, safeStorage is unavailable - the token still works in-memory
        // for this run (token-store also falls back to a private file).
        try {
          await storage.saveToken(token);
        } catch (persistErr) {
          // eslint-disable-next-line no-console
          console.warn("[auth] session not persisted:", persistErr);
        }
        set({ status: "authenticated", token, user, error: null, twoFactorToken: null });
      } catch (err) {
        // For 401 (bad creds), don't leak the server's specific phrasing -
        // a clear "incorrect email or password" beats "invalid credentials"
        // for end-user clarity. For other errors (5xx, network), surface
        // the actual message so the user knows what went wrong.
        const message =
          err instanceof ApiError && err.status === 401
            ? "Incorrect email or password"
            : err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? `Couldn't reach the server - ${err.message}`
                : "Couldn't sign in - please try again";
        set({ status: "unauthenticated", error: message });
      }
    },

    async loginTotp(code) {
      const { twoFactorToken } = get();
      if (!twoFactorToken) {
        set({ status: "unauthenticated", error: "session expired - please sign in again" });
        return;
      }
      set({ status: "loading", error: null });
      try {
        const { token, user } = await api.loginTotp({ twoFactorToken, code });
        api.setToken(token);
        setActiveKeyUser(user.id);
        if (pendingTotpPassword) {
          await syncE2eeKey(api, pendingTotpPassword);
          pendingTotpPassword = null;
        }
        // Persisting the session must never fail the login: on Linux without a
        // keyring, safeStorage is unavailable - the token still works in-memory
        // for this run (token-store also falls back to a private file).
        try {
          await storage.saveToken(token);
        } catch (persistErr) {
          // eslint-disable-next-line no-console
          console.warn("[auth] session not persisted:", persistErr);
        }
        set({ status: "authenticated", token, user, error: null, twoFactorToken: null });
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "two-factor verification failed";
        // Stay on totp-required so the user can retry; only bail to unauthenticated if the
        // intent token expired (verifying server returns AUTH error in that case too,
        // but the inline retry UX is friendlier than yanking them back to login).
        set({ status: "totp-required", error: message });
      }
    },

    cancelTotp() {
      pendingTotpPassword = null;
      set({ status: "unauthenticated", twoFactorToken: null, error: null });
    },

    async register(email, password, displayName) {
      set({ status: "loading", error: null });
      try {
        // Generate a FRESH E2EE keypair locally before hitting the server -
        // always new, never a reuse of some prior account's key on this device.
        // The server only receives the public half; the secret stays on the
        // device + an offered downloadable backup the user must save.
        const kp = generateKeyPair();
        const { token, user } = await api.register({
          email,
          password,
          displayName,
          e2eePublicKey: kp.publicKey,
        });
        api.setToken(token);
        // Now that the server assigned an id, scope + persist the key to it.
        setActiveKeyUser(user.id);
        saveKeyPair(kp);
        // Escrow the fresh key under the password so it reaches other devices.
        await syncE2eeKey(api, password);
        // Persisting the session must never fail the login: on Linux without a
        // keyring, safeStorage is unavailable - the token still works in-memory
        // for this run (token-store also falls back to a private file).
        try {
          await storage.saveToken(token);
        } catch (persistErr) {
          // eslint-disable-next-line no-console
          console.warn("[auth] session not persisted:", persistErr);
        }
        set({ status: "authenticated", token, user, error: null });
        // Trigger the backup download. User decides whether to save it; if
        // they don't, losing this device = losing DM history. Wrapped in a
        // try/catch because URL/document APIs aren't available in unit tests
        // and we don't want a missing browser API to fail the registration.
        try {
          downloadKeyBackup(email, kp);
        } catch {
          /* ignore - Settings → Account "Download key backup" is the fallback */
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Couldn't create account - please try again";
        set({ status: "unauthenticated", error: message });
      }
    },

    async logout() {
      const { token } = get();
      if (token) {
        // Clear server-side presence BEFORE we drop the token, otherwise
        // friends see us stuck "in <Room>" until our WS happens to drop.
        try { await api.setPresence(null); } catch { /* best-effort */ }
        try {
          await api.logout();
        } catch {
          // Best effort - clear client state regardless of server response
        }
      }
      api.setToken(null);
      await storage.clearToken();
      // Reset the unread store - otherwise the next user to log in on
      // this Electron session briefly sees the previous user's badges.
      useUnreadStore.setState({ counts: {}, totalUnread: 0 });
      // Don't delete the keypair on logout - the same user signing back in on
      // this device should still decrypt their old DMs (their key stays in
      // their own namespaced slot). But drop the ACTIVE user so no key is
      // readable while logged out and the next account can't touch this one's.
      setActiveKeyUser(null);
      set({ status: "unauthenticated", token: null, user: null, error: null, twoFactorToken: null });
    },

    async hydrate() {
      const persisted = await storage.getToken();
      if (!persisted) {
        set({ status: "unauthenticated" });
        return;
      }
      set({ status: "loading", token: persisted });
      api.setToken(persisted);
      try {
        const user = await api.me();
        setActiveKeyUser(user.id);
        set({ status: "authenticated", user, error: null });
      } catch {
        api.setToken(null);
        await storage.clearToken();
        set({ status: "unauthenticated", token: null, user: null });
      }
    },

    async refreshUser() {
      try {
        const user = await api.me();
        set({ user });
      } catch {
        // Best-effort refresh - leave existing user state alone on failure.
      }
    },

    async updateAvatarUrl(url) {
      const updated = await api.updateMe({ avatarUrl: url });
      const avatarUrl = updated.avatarUrl ?? null;
      set((s) => ({ user: s.user ? { ...s.user, avatarUrl } : updated }));
    },

    setServerUrl(url) {
      const clean = url.replace(/\/$/, "");
      api.setBaseUrl(clean);
      set({ serverUrl: clean });
    },
  }));
}
