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

export interface UpdateContext {
  isWeb: boolean;
  canSelfUpdate: boolean;
  /** pacman-managed Linux install (updaterInfo().pacman). */
  pacman?: boolean;
  /** Latest version to install (for the pacman .pkg.tar.zst fetch). */
  version?: string | null;
}

/**
 * Apply the update for the current build:
 *   - web               -> cache-busting reload
 *   - pacman install    -> download .pkg.tar.zst + `pkexec pacman -U` (1 password), relaunch
 *   - self-updating pkg -> relaunch (electron-updater installs on quit)
 *   - else (AUR w/o pkg, deb) -> launch the package manager in a terminal
 */
export async function performUpdate(ctx: UpdateContext): Promise<UpdateOutcome> {
  if (ctx.isWeb) {
    await reloadFresh();
    return "reload";
  }
  if (ctx.pacman && ctx.version) {
    const r = await window.r3dvoice?.pacmanInstall?.(ctx.version);
    if (r?.ok) return "relaunch"; // relaunches into the new version on success
    // else fall through to the terminal fallback (e.g. release lacks the pkg)
  }
  if (ctx.canSelfUpdate) {
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
