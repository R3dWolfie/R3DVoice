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

export type UpdateOutcome = "reload" | "relaunch" | "manual";

/** The command an AUR user runs to update (notify-only path). */
export const PKG_UPDATE_CMD = "yay -Syu r3dvoice-bin";

export interface UpdateContext {
  isWeb: boolean;
  canSelfUpdate: boolean;
  /** pacman-managed Linux install (updaterInfo().pacman). Kept for callers; the notify-only path treats it like any non-self-updating build. */
  pacman?: boolean;
  version?: string | null;
}

/**
 * Apply the update for the current build:
 *   - web               -> cache-busting reload
 *   - self-updating pkg  -> relaunch (electron-updater installs the AppImage on quit; silent, no password)
 *   - else (pacman/AUR, deb) -> notify-only: copy `yay -Syu r3dvoice-bin` to run.
 *
 * Why notify-only for pacman: the app can't escalate to root from inside its
 * sandbox (no_new_privs blocks both pkexec and a spawned `sudo`), so it can't
 * install its own root-owned system package. AUR packages are updated by the
 * user via their helper - so we copy the command instead of failing.
 */
export async function performUpdate(ctx: UpdateContext): Promise<UpdateOutcome> {
  if (ctx.isWeb) {
    await reloadFresh();
    return "reload";
  }
  if (ctx.canSelfUpdate) {
    await window.r3dvoice.relaunch();
    return "relaunch";
  }
  try {
    await navigator.clipboard?.writeText(PKG_UPDATE_CMD);
  } catch {
    /* clipboard may be unavailable; the message still tells them the command */
  }
  return "manual";
}
