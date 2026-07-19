import { app, BrowserWindow } from "electron";
// electron-updater exports a CJS-shaped module; use default import interop.
import electronUpdaterPkg from "electron-updater";
import { sendSplashStatus } from "./splash-window.js";
import type { SplashStatus } from "../shared/bridge-types.js";
const { autoUpdater } = electronUpdaterPkg;

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
