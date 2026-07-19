import { app } from "electron";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

// The splash-phase auto-updater runs in main BEFORE the renderer loads, so it
// can't read the renderer's prefs (localStorage). The renderer mirrors the two
// values the launch updater needs into this file; main reads last-known at the
// next launch. They change rarely, so last-known is fine (a fresh /health check
// still gates the actual version comparison).
export interface LaunchPrefs {
  autoUpdate: boolean;
  serverUrl: string | null;
}

const filePath = (): string => join(app.getPath("userData"), "launch-update.json");

export function readLaunchPrefs(): LaunchPrefs {
  try {
    const raw = JSON.parse(readFileSync(filePath(), "utf8")) as Partial<LaunchPrefs>;
    return {
      autoUpdate: raw.autoUpdate !== false, // default on
      serverUrl: typeof raw.serverUrl === "string" ? raw.serverUrl : null,
    };
  } catch {
    // No file yet (first launch) -> no serverUrl -> the launch updater skips.
    return { autoUpdate: true, serverUrl: null };
  }
}

export function writeLaunchPrefs(prefs: LaunchPrefs): void {
  try {
    writeFileSync(filePath(), JSON.stringify(prefs));
  } catch {
    /* best-effort; a missed write just defers auto-update to a later launch */
  }
}
