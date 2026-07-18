// Linux: per-process audio capture for screenshare via @vencord/venmic.
//
// Same approach Vesktop uses (and Discord on Linux). venmic is a native
// PipeWire patchbay that creates a virtual audio device named
// "vencord-screen-share". When you `link()` it with an exclusion list, all
// non-excluded application audio streams are routed to that virtual device.
// The renderer captures the device via getUserMedia like any other mic.
//
// Phase 1 (this version): exclude R3DVoice's own audio service from the
// virtual device, so screenshare audio carries every OTHER app's sound but
// not the call audio we're playing back. Same effect as the previous
// combine-sink hack but without modifying the user's default sink — much
// less invasive and recoverable on crash.
//
// Phase 2 (next): expose the per-app picker so the user can pick exactly
// which app to share audio from (Discord/Vesktop UX).

import { app, ipcMain } from "electron";
import { basename, join } from "node:path";
import { writeFileSync } from "node:fs";
import type { PatchBay as PatchBayType, LinkData, Node } from "@vencord/venmic";

let PatchBay: typeof PatchBayType | null = null;
let patchBay: PatchBayType | null = null;
let linked = false;
let initialized = false;

function importVenmic(): typeof PatchBayType | null {
  if (initialized) return PatchBay;
  initialized = true;
  if (process.platform !== "linux") return null;
  try {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const venmic = require("@vencord/venmic") as typeof import("@vencord/venmic");
    if (!venmic.PatchBay.hasPipeWire()) {
      safeLog("[linux-audio] PipeWire not available — venmic skipped");
      return null;
    }
    PatchBay = venmic.PatchBay;
    return PatchBay;
  } catch (err) {
    safeLog("[linux-audio] failed to load venmic:", err);
    return null;
  }
}

function obtainPatchBay(): PatchBayType | null {
  const PB = importVenmic();
  if (!PB) return null;
  if (!patchBay) {
    try {
      patchBay = new PB();
    } catch (err) {
      safeLog("[linux-audio] failed to instantiate PatchBay:", err);
      return null;
    }
  }
  return patchBay;
}

function getRendererAudioServicePid(): string | null {
  // Electron runs WebRTC audio playback in a separate "Audio Service"
  // utility process. Excluding its PID from venmic keeps R3DVoice's own
  // playback (incoming call voices) out of the virtual capture device.
  const procs = app.getAppMetrics();
  const audio = procs.find(
    (p) => p.name === "Audio Service" || p.name === "Utility: Audio Service",
  );
  return audio?.pid?.toString() ?? null;
}

/**
 * Every PID Electron has spawned for this app — main, all renderers, the
 * GPU process, every utility process (Audio Service, Network Service, etc).
 * Audio output can come from any of them depending on which renderer is
 * playing what; missing one means R3DVoice leaks into the share.
 */
function getAllR3DVoicePids(): Set<string> {
  const pids = new Set<string>();
  pids.add(String(process.pid));
  for (const proc of app.getAppMetrics()) {
    if (proc.pid) pids.add(String(proc.pid));
  }
  return pids;
}

function getR3DVoiceExcludeRules(): Node[] {
  // Match any audio stream whose origin is a R3DVoice process — by PID,
  // by binary name, by app name. Each rule is OR'd by venmic, so adding
  // more is strictly safer.
  const rules: Node[] = [];

  // One PID rule per sub-process. ~5–10 entries typical (main + audio +
  // gpu + renderers); cheap.
  for (const pid of getAllR3DVoicePids()) {
    rules.push({ "application.process.id": pid });
  }

  const execName = basename(process.execPath).toLowerCase();
  if (execName) rules.push({ "application.process.binary": execName });
  rules.push({ "application.process.binary": "r3dvoice" });

  rules.push({ "application.name": "R3DVoice" });
  rules.push({ "application.name": app.getName() });

  // Skip mic-input streams entirely so we never accidentally re-capture them.
  rules.push({ "media.class": "Stream/Input/Audio" });

  return rules;
}

function safeLog(...args: unknown[]): void {
  try {
    // eslint-disable-next-line no-console
    console.log(...args);
  } catch {
    /* */
  }
}

export interface EnableResult {
  /** Label of the virtual capture device — match it via enumerateDevices. */
  monitorDeviceDescription: string;
}

export interface AudioSourceSummary {
  /** node.name — stable identifier across the same app session. */
  nodeName: string;
  /** application.name — human-friendly app label. */
  appName: string;
  /** application.process.id — for tie-breaking when same-named apps run twice. */
  processId: string;
  /** Optional icon name (XDG), if PipeWire reported one. */
  iconName?: string;
}

/** Friendly label that prefers the binary name when the app name is generic. */
function labelForNode(n: Record<string, string>): string {
  const app = n["application.name"]?.trim() ?? "";
  const binary = (n["application.process.binary"] ?? "")
    .replace(/\.(bin|exe)$/i, "")
    .trim();
  const node = n["node.name"]?.trim() ?? "";

  // PipeWire wraps ALSA-using apps under several different prefixes
  // ("ALSA plug-in", "PipeWire ALSA", "JACK", "PulseAudio") followed by
  // the bracketed exe name. Pull the inner string out — that's what the
  // user actually recognizes (osu!, wine games, etc.).
  const wrapped = /\[([^\]]+)\]\s*$/.exec(app);
  if (
    wrapped?.[1] &&
    /^(?:ALSA plug-in|PipeWire ALSA|JACK|PulseAudio)/i.test(app)
  ) {
    return wrapped[1].replace(/\.(bin|exe)$/i, "").trim();
  }

  // Electron / Mozilla apps all expose application.name === "Chromium" /
  // "Mozilla", which is useless as a picker label. Fall back to the binary
  // name (or node.name) so the user sees "vesktop", "discord", "obs", etc.
  if (!app || /^(chromium|electron|mozilla|webkit|alsa[- ]plug[- ]?in)$/i.test(app)) {
    return binary || node || app || "Unknown";
  }
  return app;
}

/** List audio-producing apps PipeWire knows about, with R3DVoice filtered out. */
export function listLinuxAudioSources(): AudioSourceSummary[] {
  const pb = obtainPatchBay();
  if (!pb) return [];

  // Build a "is this R3DVoice?" predicate using the same facet matches we
  // hand to PatchBay.link()'s exclude. PipeWire reports audio streams under
  // multiple sub-process PIDs (main, Audio Service, renderer, GPU);
  // single-PID exclusion misses some, so the user sees their own "Chromium"
  // entry. Enumerate every Electron sub-process PID via getAppMetrics().
  const ourPids = getAllR3DVoicePids();
  const execName = basename(process.execPath).toLowerCase();
  const appName = app.getName();
  const isR3DVoice = (n: Record<string, string>): boolean => {
    const pid = n["application.process.id"];
    if (pid && ourPids.has(pid)) return true;
    const bin = n["application.process.binary"]?.toLowerCase();
    if (bin === execName) return true;
    if (bin === "r3dvoice") return true;
    // Catch substring matches in case the binary is wrapped (AppRun /
    // appimage-launcher) or someone renamed the bundle.
    if (bin && bin.includes("r3dvoice")) return true;
    if (n["application.name"] === "R3DVoice") return true;
    if (n["application.name"] === appName) return true;
    return false;
  };

  try {
    // Match Vesktop exactly: list() with default props, no media.class
    // gate, only drop our own audio service PID. Then layer the friendly
    // label + dedup + R3DVoice filter on top.
    const nodes = pb.list();

    // AppImages launched from the desktop have closed stdout, so safeLog
    // disappears. Mirror the diagnostic to a file in userData — but only when
    // explicitly opted in (R3DVOICE_AUDIO_DEBUG), since it dumps every app's
    // node/window/media names, which is sensitive to write in production.
    if (process.env["R3DVOICE_AUDIO_DEBUG"]) {
      try {
        const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
        const lines: string[] = [];
        lines.push(`# linux-audio diagnostic — ${new Date().toISOString()}`);
        lines.push(`venmic returned ${nodes.length} nodes`);
        lines.push("");
        nodes.forEach((n, i) => {
          lines.push(`--- node ${i} ---`);
          for (const [k, v] of Object.entries(n)) {
            lines.push(`  ${k} = ${v}`);
          }
        });
        writeFileSync(join(userData, "linux-audio-debug.log"), lines.join("\n"), "utf8");
      } catch {
        /* */
      }
    }

    safeLog(`[linux-audio] venmic returned ${nodes.length} nodes`);

    const seen = new Set<string>();
    const out: AudioSourceSummary[] = [];
    for (const n of nodes) {
      if (isR3DVoice(n)) continue;
      const label = labelForNode(n);
      if (!label || label === "Unknown") continue;
      const nodeName = n["node.name"] ?? "";
      const processId = n["application.process.id"] ?? "";
      const key = `${label}::${processId}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({
        nodeName,
        appName: label,
        processId,
        ...(n["application.icon-name"] ? { iconName: n["application.icon-name"] } : {}),
      });
    }
    safeLog(`[linux-audio] surfacing ${out.length} sources after dedup/filter`);
    return out;
  } catch (err) {
    safeLog("[linux-audio] list() threw:", err);
    return [];
  }
}

export interface EnableOptions {
  /**
   * If given, capture only this specific app (by application.process.id).
   * If omitted, capture every output stream except R3DVoice itself —
   * the existing v0.4.14 behavior.
   */
  includeProcessId?: string;
}

const GENERIC_APP_NAME_RE = /^(chromium|electron|mozilla|firefox|webkit|wine|wine64|alsa[- ]plug[- ]?in|pipewire alsa|pulseaudio|jack)$/i;

/**
 * Turn a picked process.id into robust include rules. A single app can emit
 * audio under several PIDs (wine/proton, ALSA-plugin wrappers, XDG sandboxes),
 * so the PID the picker captured may not be the exact one the audio node runs
 * on. Resolve the PID to its node's identity and OR-match the whole app:
 *   - node.name          (specific per-node, stable within a session)
 *   - application.process.binary  (unless a generic wrapper like "wine")
 * plus the raw PID as a fallback facet. If the node can't be found (stale
 * pick), fall back to the raw PID match — i.e. the previous behavior. Every
 * rule is scoped to the chosen app, so this can only broaden capture to that
 * app, never leak another app's audio in.
 */
function resolveIncludeRules(pb: PatchBayType, processId: string): Node[] {
  try {
    const nodes = pb.list();
    const match = nodes.find((n) => n["application.process.id"] === processId);
    if (!match) return [{ "application.process.id": processId }];
    const rules: Node[] = [];
    const nodeName = match["node.name"]?.trim();
    const binary = match["application.process.binary"]?.trim();
    if (nodeName) rules.push({ "node.name": nodeName });
    if (binary && !GENERIC_APP_NAME_RE.test(binary.replace(/\.(bin|exe)$/i, ""))) {
      rules.push({ "application.process.binary": binary });
    }
    rules.push({ "application.process.id": processId });
    safeLog(`[linux-audio] per-app include resolved to ${rules.length} facet(s) for PID ${processId}`);
    return rules;
  } catch (err) {
    safeLog("[linux-audio] resolveIncludeRules failed, using raw PID:", err);
    return [{ "application.process.id": processId }];
  }
}

/** Idempotent. Returns null if venmic isn't available (no PipeWire / load failed). */
export function enableLinuxAudioRouting(options: EnableOptions = {}): EnableResult | null {
  const pb = obtainPatchBay();
  if (!pb) return null;
  // Re-link if we're already linked but the caller wants a different scope —
  // PatchBay.link() replaces the existing graph wiring atomically.

  const excludeRules = getR3DVoiceExcludeRules();
  if (excludeRules.length === 0) {
    safeLog("[linux-audio] no exclude rules derivable; aborting to avoid self-capture");
    return null;
  }

  const data: LinkData = options.includeProcessId
    ? {
        include: resolveIncludeRules(pb, options.includeProcessId),
        exclude: excludeRules,
        ignore_devices: true,
      }
    : {
        include: [],
        exclude: excludeRules,
        only_speakers: true,
        ignore_devices: true,
      };

  try {
    const ok = pb.link(data);
    if (!ok) {
      safeLog("[linux-audio] PatchBay.link() returned false");
      return null;
    }
    linked = true;
    safeLog(
      "[linux-audio] venmic linked —",
      options.includeProcessId
        ? `including PID ${options.includeProcessId}`
        : `excluding ${excludeRules.length} R3DVoice rules`,
    );
    return { monitorDeviceDescription: "vencord-screen-share" };
  } catch (err) {
    safeLog("[linux-audio] PatchBay.link() threw:", err);
    return null;
  }
}

/** Tear down the venmic link. Safe to call when not enabled. */
export function disableLinuxAudioRouting(): void {
  if (!patchBay || !linked) return;
  try { patchBay.unlink(); } catch (err) { safeLog("[linux-audio] unlink threw:", err); }
  linked = false;
  safeLog("[linux-audio] venmic unlinked");
}

export function registerLinuxAudioRoutingHandlers(): void {
  ipcMain.handle("linux-audio-routing:enable", (_evt, options?: EnableOptions) =>
    enableLinuxAudioRouting(options),
  );
  ipcMain.handle("linux-audio-routing:disable", () => disableLinuxAudioRouting());
  ipcMain.handle("linux-audio-routing:list-sources", () => listLinuxAudioSources());
}

// Best-effort cleanup so we don't leave the virtual device hanging when the
// app exits. venmic auto-releases its PipeWire links when the process dies,
// but unlinking explicitly is faster.
app.on("will-quit", () => {
  disableLinuxAudioRouting();
});
