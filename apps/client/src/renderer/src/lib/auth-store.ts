import { createStore, type StoreApi } from "zustand/vanilla";
import type { UserDTO } from "@r3dvoice/shared";
import { ApiClient, ApiError } from "./api.js";
import { ensureKeyPair, downloadKeyBackup, clearKeyPair } from "./key-storage.js";
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
          set({ status: "totp-required", twoFactorToken: res.twoFactorToken, error: null });
          return;
        }
        const { token, user } = res;
        api.setToken(token);
        // Persisting the session must never fail the login: on Linux without a
        // keyring, safeStorage is unavailable — the token still works in-memory
        // for this run (token-store also falls back to a private file).
        try {
          await storage.saveToken(token);
        } catch (persistErr) {
          // eslint-disable-next-line no-console
          console.warn("[auth] session not persisted:", persistErr);
        }
        set({ status: "authenticated", token, user, error: null, twoFactorToken: null });
      } catch (err) {
        // For 401 (bad creds), don't leak the server's specific phrasing —
        // a clear "incorrect email or password" beats "invalid credentials"
        // for end-user clarity. For other errors (5xx, network), surface
        // the actual message so the user knows what went wrong.
        const message =
          err instanceof ApiError && err.status === 401
            ? "Incorrect email or password"
            : err instanceof ApiError
              ? err.message
              : err instanceof Error
                ? `Couldn't reach the server — ${err.message}`
                : "Couldn't sign in — please try again";
        set({ status: "unauthenticated", error: message });
      }
    },

    async loginTotp(code) {
      const { twoFactorToken } = get();
      if (!twoFactorToken) {
        set({ status: "unauthenticated", error: "session expired — please sign in again" });
        return;
      }
      set({ status: "loading", error: null });
      try {
        const { token, user } = await api.loginTotp({ twoFactorToken, code });
        api.setToken(token);
        // Persisting the session must never fail the login: on Linux without a
        // keyring, safeStorage is unavailable — the token still works in-memory
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
      set({ status: "unauthenticated", twoFactorToken: null, error: null });
    },

    async register(email, password, displayName) {
      set({ status: "loading", error: null });
      try {
        // Generate the E2EE keypair locally before hitting the server. The
        // server only receives the public half; the secret stays on the
        // device + an offered downloadable backup the user must save.
        const kp = ensureKeyPair();
        const { token, user } = await api.register({
          email,
          password,
          displayName,
          e2eePublicKey: kp.publicKey,
        });
        api.setToken(token);
        // Persisting the session must never fail the login: on Linux without a
        // keyring, safeStorage is unavailable — the token still works in-memory
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
          /* ignore — Settings → Account "Download key backup" is the fallback */
        }
      } catch (err) {
        const message = err instanceof ApiError ? err.message : "Couldn't create account — please try again";
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
          // Best effort — clear client state regardless of server response
        }
      }
      api.setToken(null);
      await storage.clearToken();
      // Reset the unread store — otherwise the next user to log in on
      // this Electron session briefly sees the previous user's badges.
      useUnreadStore.setState({ counts: {}, totalUnread: 0 });
      // Don't clear the E2EE keypair on logout — same user signing back in
      // on this device should still decrypt their old DMs. Use clearKeyPair()
      // explicitly during a "switch user / forget me" flow.
      void clearKeyPair; // marker for future use
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
        // Best-effort refresh — leave existing user state alone on failure.
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
