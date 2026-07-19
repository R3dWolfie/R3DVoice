// Shared "perform the update" logic used by the titlebar UpdateButton, the
// Settings > Updates tab, and the update popup. Platform-agnostic: the caller
// passes isWeb / canSelfUpdate (computed from Primitives.IS_WEB + updaterInfo)
// so this module has no circular import back into the component tree.

/**
 * Web reload that actually loads the fresh bundle. A plain reload can be served
 * the stale bundle back by a service worker / PWA / CDN edge cache, so clear
 * those and reload past caches with a one-shot bust param.
 */
export async function reloadFresh(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best-effort */
  }
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("_u", Date.now().toString(36));
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

export type UpdateOutcome = "reload" | "relaunch" | "pkg-launched" | "pkg-failed";

/**
 * Apply the update for the current build:
 *   - web              -> cache-busting reload
 *   - self-updating pkg -> relaunch (electron-updater installs on quit)
 *   - AUR/pacman        -> launch the package manager (returns pkg-launched/failed)
 */
export async function performUpdate(isWeb: boolean, canSelfUpdate: boolean): Promise<UpdateOutcome> {
  if (isWeb) {
    await reloadFresh();
    return "reload";
  }
  if (canSelfUpdate) {
    await window.r3dvoice.relaunch();
    return "relaunch";
  }
  let launched = false;
  try {
    const r = await window.r3dvoice?.runPackageUpdate?.();
    launched = Boolean(r?.launched);
  } catch {
    /* fall through */
  }
  return launched ? "pkg-launched" : "pkg-failed";
}
