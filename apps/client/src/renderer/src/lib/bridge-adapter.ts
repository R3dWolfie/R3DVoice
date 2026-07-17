import type { AuthStorageAdapter } from "./auth-store.js";

/** Bridges window.r3dvoice (exposed by preload) to AuthStorageAdapter. */
export const bridgeStorageAdapter: AuthStorageAdapter = {
  saveToken: (t) => window.r3dvoice.saveToken(t),
  getToken: () => window.r3dvoice.getToken(),
  clearToken: () => window.r3dvoice.clearToken(),
};
