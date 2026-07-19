import { useEffect, type ReactElement } from "react";
import { APP_VERSION } from "./Primitives.js";
import { useAuthStore } from "../lib/auth-context.js";
import { usePrefs } from "../lib/prefs-singleton.js";
import { compareVersions, fetchLatestClientVersion } from "../lib/update-check.js";

// Fire at most once per process: a pacman auto-install pops a pkexec prompt and
// relaunches, so re-running on every remount / route change would nag.
let attempted = false;

/**
 * Silent auto-update on launch for pacman-managed Linux installs. If the
 * "Auto updates" pref is on and a newer version is published, download the
 * release's .pkg.tar.zst and `pkexec pacman -U` it (one password), then
 * relaunch into it. Opt out via Settings > Updates or the popup checkbox
 * (both flip the pref). Renders nothing.
 *
 * Only the pacman path self-installs here. Web reloads on demand,
 * electron-updater builds install on quit, and AUR-without-pkg needs the
 * terminal path (a manual action, not a silent pkexec prompt).
 */
export function AutoUpdater(): ReactElement | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const autoUpdate = usePrefs((s) => s.autoUpdate);

  useEffect(() => {
    if (attempted || !autoUpdate || !serverUrl) return;
    let cancelled = false;
    void (async () => {
      const info = await window.r3dvoice?.updaterInfo?.().catch(() => null);
      if (cancelled || !info?.pacman) return;
      const latest = await fetchLatestClientVersion(serverUrl);
      if (cancelled || !latest || APP_VERSION === "dev") return;
      if (compareVersions(APP_VERSION, latest) >= 0) return; // already current
      attempted = true; // set before await so strict-mode double-invoke can't double-fire
      await window.r3dvoice?.pacmanInstall?.(latest); // downloads + pkexec + relaunch on success
    })();
    return () => {
      cancelled = true;
    };
  }, [serverUrl, autoUpdate]);

  return null;
}
