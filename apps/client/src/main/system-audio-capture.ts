// Spawns the bundled `system-audio-capture.exe` helper (Windows only) and
// pipes its raw PCM stdout into the renderer over IPC. The helper captures
// the system audio mix EXCLUDING the R3DVoice process tree, so screenshare
// audio doesn't include the call voices we're playing back ourselves.
//
// Format from the helper: signed 16-bit LE PCM, 48000 Hz, 2 channels, interleaved.
// Quietly does nothing on non-Windows or in dev (when the binary isn't bundled);
// the caller treats "no session started" as a graceful fallback.

import { app, ipcMain, type WebContents } from "electron";
import { spawn, type ChildProcess, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";

// PCM format the helper produces - kept in sync with LoopbackCapture.cpp's
// m_CaptureFormat. The renderer needs these to reconstruct a MediaStream.
export const SYSTEM_AUDIO_FORMAT = {
  sampleRate: 48000,
  channels: 2,
  bitsPerSample: 16,
} as const;

// Time we give the helper to produce its first audio packet. Activation
// is async on the WASAPI side; on a build of Windows that doesn't support
// PROCESS_LOOPBACK_MODE, StartCaptureAsync returns an error fast (~50 ms).
// On supported builds the first packet typically arrives in <500 ms.
const FIRST_CHUNK_TIMEOUT_MS = 3_000;

interface Session {
  child: ChildProcessWithoutNullStreams;
  webContents: WebContents;
  stopped: boolean;
}

let session: Session | null = null;

function helperPath(): string | null {
  if (process.platform !== "win32") return null;
  if (!app.isPackaged) {
    // Dev builds don't ship the binary - Linux/Mac devs can't compile it
    // anyway. Skipping is fine; the feature degrades gracefully.
    return null;
  }
  const candidate = join(process.resourcesPath, "system-audio-capture.exe");
  return existsSync(candidate) ? candidate : null;
}

function safeSend(wc: WebContents, channel: string, ...args: unknown[]): void {
  if (wc.isDestroyed()) return;
  try {
    wc.send(channel, ...args);
  } catch {
    /* renderer gone */
  }
}

export interface AudioSessionInfo {
  pid: number;
  imageName: string;
  displayName: string;
}

/** Spawn the helper with --list-sessions, parse the TSV output. Empty list on any error. */
export function listWindowsAudioSessions(): Promise<AudioSessionInfo[]> {
  return new Promise((resolve) => {
    const exe = helperPath();
    if (!exe) return resolve([]);

    let child: ChildProcess;
    try {
      child = spawn(exe, ["--list-sessions"], {
        stdio: ["ignore", "pipe", "pipe"],
        windowsHide: true,
      });
    } catch {
      return resolve([]);
    }

    let stdout = "";
    child.stdout?.on("data", (d: Buffer) => { stdout += d.toString("utf8"); });
    child.on("error", () => resolve([]));
    child.on("exit", () => {
      const sessions: AudioSessionInfo[] = [];
      const ourPids = new Set<string>();
      for (const proc of app.getAppMetrics()) {
        if (proc.pid) ourPids.add(String(proc.pid));
      }
      for (const line of stdout.split("\n")) {
        if (!line.trim()) continue;
        const parts = line.split("\t");
        if (parts.length < 2) continue;
        const pidStr = parts[0]!;
        const imageName = parts[1]!;
        const displayName = parts[2] ?? "";
        const pid = Number.parseInt(pidStr, 10);
        if (!Number.isFinite(pid)) continue;
        // Drop our own process tree so users don't pick R3DVoice.
        if (ourPids.has(pidStr)) continue;
        sessions.push({ pid, imageName, displayName });
      }
      // Stable order: alphabetical by display label.
      sessions.sort((a, b) => labelFor(a).localeCompare(labelFor(b)));
      resolve(sessions);
    });

    setTimeout(() => {
      try { child.kill(); } catch { /* */ }
    }, 5_000);
  });
}

function labelFor(s: AudioSessionInfo): string {
  return s.displayName?.trim() || s.imageName.replace(/\.exe$/i, "");
}

/**
 * Start the helper and stream PCM chunks to `webContents`. Resolves to:
 *   - "started" if the helper spawned and produced its first packet within timeout
 *   - "unsupported" if the binary isn't available, OR spawn failed, OR the helper
 *     errored before the first packet (Windows build too old, etc.)
 *
 * Pass `includePid` to capture only that process's audio (per-app share).
 * Default is exclude-self (system mix minus R3DVoice).
 */
export function startSystemAudioCapture(
  webContents: WebContents,
  options: { includePid?: number } = {},
): Promise<"started" | "unsupported"> {
  if (session && !session.stopped) {
    return Promise.resolve("started");
  }

  const exe = helperPath();
  if (!exe) return Promise.resolve("unsupported");

  const args: string[] = options.includePid
    ? ["--include-pid", String(options.includePid)]
    : ["--exclude-pid", String(process.pid)];

  let child: ChildProcessWithoutNullStreams;
  try {
    child = spawn(exe, args, {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
  } catch {
    // eslint-disable-next-line no-console
    console.error(`[system-audio] spawn failed for ${exe} ${args.join(" ")}`);
    return Promise.resolve("unsupported");
  }
  // eslint-disable-next-line no-console
  console.log(`[system-audio] helper started pid=${child.pid} args=${args.join(" ")}`);

  return new Promise<"started" | "unsupported">((resolve) => {
    let firstChunkSeen = false;
    const settled = (result: "started" | "unsupported"): void => {
      if (firstChunkSeen) return; // already settled
      firstChunkSeen = true;
      resolve(result);
    };

    const timeout = setTimeout(() => {
      // Helper didn't produce audio in time - kill it and report unsupported.
      try { child.kill(); } catch { /* already gone */ }
      settled("unsupported");
    }, FIRST_CHUNK_TIMEOUT_MS);

    child.stdout.on("data", (chunk: Buffer) => {
      if (!firstChunkSeen) {
        clearTimeout(timeout);
        settled("started");
      }
      // Forward as Uint8Array - Electron serializes Buffer through structured
      // clone but staying explicit is cheaper and avoids surprises if a future
      // Electron tightens that path.
      safeSend(webContents, "system-audio:chunk", new Uint8Array(chunk));
    });

    child.stderr.on("data", (_chunk: Buffer) => {
      // Helper logs to stderr on activation failure. We don't surface the
      // text - the timeout/exit path is enough to fall back. Could route to
      // a debug log in the future.
    });

    child.on("error", () => {
      clearTimeout(timeout);
      settled("unsupported");
    });

    child.on("exit", () => {
      clearTimeout(timeout);
      // If we hadn't seen a chunk yet, treat as unsupported.
      settled("unsupported");
      if (session && session.child === child) {
        session.stopped = true;
        safeSend(session.webContents, "system-audio:ended");
        session = null;
      }
    });

    session = { child, webContents, stopped: false };
  });
}

export async function stopSystemAudioCapture(): Promise<void> {
  if (!session) return;
  const dying = session;
  session = null;
  dying.stopped = true;
  // Detach data forwarding *synchronously* - otherwise the old child keeps
  // streaming PCM chunks into the renderer for the few hundred ms it takes
  // to shut down via stdin EOF, mixing with whatever the next session
  // produces. (User-visible bug: picking "osu!" in the per-app picker still
  // leaked voice into the share because the previous --exclude-pid helper
  // was still pumping its system-mix PCM in parallel.)
  try { dying.child.stdout.removeAllListeners("data"); } catch { /* */ }
  try { dying.child.stderr.removeAllListeners("data"); } catch { /* */ }
  // Try graceful first (stdin EOF), fall back to kill quickly.
  try { dying.child.stdin.end(); } catch { /* */ }
  await new Promise<void>((resolve) => {
    if (dying.child.exitCode !== null || dying.child.killed) return resolve();
    let resolved = false;
    const finish = (): void => { if (!resolved) { resolved = true; resolve(); } };
    dying.child.once("exit", finish);
    // Hard kill after 250ms - racing two helpers is much worse than a hard
    // kill of one we already told to stop.
    setTimeout(() => {
      if (!dying.child.killed) {
        try { dying.child.kill(); } catch { /* */ }
      }
    }, 250);
    setTimeout(finish, 1000);
  });
}

export function registerSystemAudioCaptureHandlers(): void {
  ipcMain.handle("system-audio:start", async (event, options?: { includePid?: number }) => {
    return startSystemAudioCapture(event.sender, options ?? {});
  });
  ipcMain.handle("system-audio:stop", async () => {
    await stopSystemAudioCapture();
  });
  ipcMain.handle("system-audio:format", () => SYSTEM_AUDIO_FORMAT);
  ipcMain.handle("system-audio:list-sessions", () => listWindowsAudioSessions());
}
