import { app, BrowserWindow } from "electron";
// electron-updater exports a CJS-shaped module; use default import interop.
import electronUpdaterPkg from "electron-updater";
import { sendSplashStatus } from "./splash-window.js";
import { installPacmanPackage } from "./pacman-install.js";
import { readLaunchPrefs } from "./launch-prefs.js";
import type { SplashStatus } from "../shared/bridge-types.js";
const { autoUpdater } = electronUpdaterPkg;

/** Dotted-version compare: <0 if a<b, 0 equal, >0 if a>b. */
function compareVersions(a: string, b: string): number {
  const pa = a.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.replace(/^v/, "").split(".").map((n) => parseInt(n, 10) || 0);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return 0;
}

/**
 * pacman/AUR builds can't use electron-updater (root-owned /opt), so the
 * launch-time auto-install happens here instead: while the splash still holds
 * the screen, check the server's latest version and, if newer, download the
 * release package and `pkexec pacman -U` it (one password prompt, in the
 * context of "app is starting"), then relaunch. Returns true if it kicked off
 * an install (the process is on its way out). Any failure/skip returns false
 * and the app opens normally - the in-app Update controls remain as a fallback.
 */
async function tryPacmanSplashUpdate(send: (s: SplashStatus) => void): Promise<boolean> {
  if (process.platform !== "linux") return false;
  const { autoUpdate, serverUrl } = readLaunchPrefs();
  if (!autoUpdate || !serverUrl) return false;

  let latest: string | null = null;
  try {
    send({ phase: "checking" });
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/health`);
    if (!res.ok) return false;
    const body = (await res.json()) as { latestClientVersion?: unknown };
    latest = typeof body.latestClientVersion === "string" ? body.latestClientVersion : null;
  } catch {
    return false;
  }
  if (!latest || compareVersions(app.getVersion(), latest) >= 0) return false;

  send({ phase: "downloaded", message: `Installing ${latest}…` });
  const r = await installPacmanPackage(latest);
  if (!r.ok) return false;
  app.relaunch();
  app.exit(0);
  return true;
}

export type UpdateOutcome =
  | { kind: "no-update" }
  | { kind: "error" }
  | { kind: "timeout" }
  | { kind: "installing" };

function safeLog(...args: unknown[]): void {
  // Swallow EPIPE. When launched from a desktop-file with no terminal,
  // process.stdout/stderr are closed - any write throws uncaught EPIPE
  // and crashes the main process. Wrap every log site.
  try {
    // eslint-disable-next-line no-console
    console.log(...args);
  } catch {
    /* no stdout */
  }
}

/**
 * Block startup until either: an update is downloaded and silent-installed
 * (process exits), the server says no update, an error happens, or a timeout
 * trips. The caller awaits this and only opens the main window when the
 * outcome isn't "installing".
 *
 * In dev (unpackaged) we skip electron-updater entirely (it crashes on
 * unpackaged apps) but synthesize a snappy initializing → loading sequence
 * so the splash still feels alive.
 */
export async function initAutoUpdate(
  splash: BrowserWindow | null = null,
  timeoutMs = 30_000,
): Promise<UpdateOutcome> {
  const send = (status: SplashStatus): void => sendSplashStatus(splash, status);

  if (!app.isPackaged) {
    setTimeout(() => send({ phase: "loading" }), 250);
    return { kind: "no-update" };
  }

  // Distro/package-manager installs (AUR, .deb, Flatpak) own updates via the
  // system package manager. The AUR wrapper sets R3DVOICE_DISABLE_UPDATER=1 so
  // electron-updater doesn't try to overwrite a root-owned install (which fails
  // noisily) and doesn't fight `yay -Syu`. Standalone AppImages leave it unset
  // and self-update normally.
  if (process.env["R3DVOICE_DISABLE_UPDATER"]) {
    // pacman/AUR: install during the splash (one password, "app is starting"
    // context) instead of a jarring prompt after the window is open.
    if (await tryPacmanSplashUpdate(send)) return { kind: "installing" };
    setTimeout(() => send({ phase: "loading" }), 250);
    return { kind: "no-update" };
  }

  // Disable electron-updater's default logger - it calls console.* with
  // verbose output, which EPIPEs when launched headlessly (no terminal).
  autoUpdater.logger = null;

  autoUpdater.autoDownload = true;
  // Safety net: if the user force-quits during download (or we hit the
  // startup timeout while still downloading), the partial download finishes
  // and installs on the next clean quit instead of being lost.
  autoUpdater.autoInstallOnAppQuit = true;

  const outcome = new Promise<UpdateOutcome>((resolve) => {
    let settled = false;
    const settle = (result: UpdateOutcome): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };

    autoUpdater.on("checking-for-update", () => {
      send({ phase: "checking" });
    });

    autoUpdater.on("update-not-available", () => {
      send({ phase: "loading" });
      settle({ kind: "no-update" });
    });

    autoUpdater.on("update-available", (info) => {
      safeLog("[auto-update] update available:", info.version);
      send({ phase: "available", message: `Update ${info.version} available` });
    });

    autoUpdater.on("download-progress", (progress) => {
      const percent = typeof progress.percent === "number" ? progress.percent : 0;
      send({ phase: "downloading", percent });
    });

    autoUpdater.on("update-downloaded", (info) => {
      safeLog("[auto-update] update downloaded:", info.version);
      send({ phase: "downloaded", message: `Installing ${info.version}…` });
      // Silent install + auto-relaunch. Resolve as "installing" so the
      // caller knows not to bother opening the main window - the process
      // is exiting. setImmediate so the splash status flush gets out first.
      settle({ kind: "installing" });
      setImmediate(() => {
        try {
          autoUpdater.quitAndInstall(true, true);
        } catch (err) {
          safeLog("[auto-update] quitAndInstall failed:", err);
        }
      });
    });

    autoUpdater.on("error", (err) => {
      safeLog("[auto-update] error:", err);
      send({ phase: "error", message: err instanceof Error ? err.message : String(err) });
      settle({ kind: "error" });
    });

    void autoUpdater.checkForUpdates().catch(() => {
      // Offline, rate-limited, etc. - proceed with current version.
      settle({ kind: "error" });
    });
  });

  const result = await Promise.race<UpdateOutcome>([
    outcome,
    new Promise<UpdateOutcome>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
    ),
  ]);

  // Re-check every 2 hours so a long-running session eventually catches
  // updates without forcing a restart. Result still lands on next quit via
  // autoInstallOnAppQuit; we don't force-quit a running session.
  setInterval(() => {
    void autoUpdater.checkForUpdates().catch(() => {
      /* swallow */
    });
  }, 2 * 60 * 60 * 1000);

  return result;
}
