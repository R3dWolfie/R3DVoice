import { createContext, useContext, useEffect, useMemo, useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import type { StoreApi } from "zustand/vanilla";
import { ApiClient } from "./api.js";
import { createAuthStore, type AuthState } from "./auth-store.js";
import { bridgeStorageAdapter } from "./bridge-adapter.js";
import { prefsActions } from "./prefs-singleton.js";

const Ctx = createContext<StoreApi<AuthState> | null>(null);

export function AuthProvider({ children }: { children: ReactNode }): ReactElement {
  const store = useMemo(() => {
    // Use the persisted server URL from prefs so hydrate() hits the right
    // /me endpoint on first paint. Falls back to the auth-store's default
    // (https://voice.r3dwolfie.com) if prefs haven't loaded yet.
    const persistedUrl = prefsActions().serverUrl;
    const api = new ApiClient(persistedUrl);
    const s = createAuthStore(api, bridgeStorageAdapter);
    s.getState().setServerUrl(persistedUrl);
    return s;
  }, []);

  useEffect(() => {
    void store.getState().hydrate();
  }, [store]);

  return <Ctx.Provider value={store}>{children}</Ctx.Provider>;
}

export function useAuthStore<T>(selector: (s: AuthState) => T): T {
  const store = useContext(Ctx);
  if (!store) throw new Error("useAuthStore must be used inside AuthProvider");
  return useSyncExternalStore(
    store.subscribe,
    () => selector(store.getState()),
    () => selector(store.getState()),
  );
}

export function useNeedsHandle(): boolean {
  return useAuthStore((s) => s.user !== null && (s.user.handle === null || s.user.handle === undefined));
}

// True only when the server flagged this account as unverified (email
// configured + link unclicked). Absent/true field = no gate - self-hosters
// without SMTP are never gated.
export function useNeedsEmailVerify(): boolean {
  return useAuthStore((s) => s.user !== null && s.user.emailVerified === false);
}
