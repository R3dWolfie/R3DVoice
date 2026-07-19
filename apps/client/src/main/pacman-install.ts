import { app } from "electron";
import { writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { join } from "node:path";

export interface PacmanInstallResult {
  ok: boolean;
  error?: string;
}

/**
 * Download the release .pkg.tar.zst for `version` and install it with a single
 * GUI password prompt (`pkexec pacman -U`). Does NOT relaunch - the caller
 * decides (the splash path relaunches into the new version; the manual button
 * does too). Shared by the launch-time auto-updater and the in-app update
 * controls so there's one install path.
 */
export async function installPacmanPackage(version: string): Promise<PacmanInstallResult> {
  if (process.platform !== "linux" || !/^[0-9.]+$/.test(version)) {
    return { ok: false, error: "unsupported" };
  }
  const url = `https://github.com/R3dWolfie/R3DVoice/releases/download/v${version}/R3DVoice.pkg.tar.zst`;
  const tmp = join(app.getPath("temp"), `r3dvoice-${version}.pkg.tar.zst`);
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, error: `download ${res.status}` };
    writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  } catch (err) {
    return { ok: false, error: `download failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const ok = await new Promise<boolean>((resolve) => {
    try {
      const child = spawn("pkexec", ["pacman", "-U", "--noconfirm", tmp], { stdio: "ignore" });
      child.on("error", () => resolve(false));
      child.on("exit", (code) => resolve(code === 0));
    } catch {
      resolve(false);
    }
  });
  try {
    rmSync(tmp, { force: true });
  } catch {
    /* temp cleanup best-effort */
  }
  return ok ? { ok: true } : { ok: false, error: "install failed or cancelled" };
}
