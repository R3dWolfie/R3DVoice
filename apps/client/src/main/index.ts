import { app, BrowserWindow, crashReporter, desktopCapturer, dialog, ipcMain, Menu, screen, session, shell, systemPreferences } from "electron";
import { join } from "node:path";
import { existsSync, writeFileSync, rmSync } from "node:fs";
import { spawn } from "node:child_process";
import { saveToken, getToken, clearToken } from "./token-store.js";
import { openScreenPicker, registerScreenPickerHandlers } from "./screen-picker.js";
import { setPttKeybind, teardownKeybinds } from "./keybinds.js";
import { initAutoUpdate } from "./auto-update.js";
import { installPacmanPackage } from "./pacman-install.js";
import { writeLaunchPrefs } from "./launch-prefs.js";
import { registerSystemAudioCaptureHandlers, stopSystemAudioCapture } from "./system-audio-capture.js";
import { registerLinuxAudioRoutingHandlers } from "./linux-audio-routing.js";
import {
  getInitialWindowBounds,
  shouldStartMaximized,
  trackWindowState,
} from "./window-state.js";
import { writeDesktopEntry, resolveIconPath } from "./desktop-integration.js";
import { hardenWebContents } from "./web-contents-guard.js";
import {
  openSplashWindow,
  sendSplashStatus,
  closeSplash,
} from "./splash-window.js";
import {
  registerDeepLinkHandlers,
  extractDeepLinkFromArgv,
  parseDeepLink,
  dispatchDeepLink,
} from "./deep-links.js";
import { registerNotificationsHandler } from "./notifications.js";

// Force app name / WMClass to "R3DVoice" so Plasma/GNOME taskbars match this
// window to ~/.local/share/applications/r3dvoice.desktop instead of falling
// back to the AppImage's bundled @r3dvoiceclient.desktop (which lives inside
// a temporary mount that vanishes on exit).
app.setName("R3DVoice");
app.commandLine.appendSwitch("class", "R3DVoice");
Menu.setApplicationMenu(null);

// Force WebRTC H.264 encoding to go through hardware (Media Foundation on
// Windows, VAAPI on Linux, VideoToolbox on macOS) instead of falling back
// to the OpenH264 software encoder. v0.5.5 stats showed impl=OpenH264 with
// enc=0–2 fps at 1080p60 - software encode simply cannot keep up.
//
// `ignore-gpu-blocklist` lets GPUs flagged by Chromium (often for stale
// driver bugs) still use HW. The feature list collects the flags that gate
// the hardware H.264 / video-encode path on each platform Chromium 134
// recognises - not all are active on every platform but extras are no-ops.
app.commandLine.appendSwitch("ignore-gpu-blocklist");
app.commandLine.appendSwitch(
  "enable-features",
  [
    // Windows: route WebRTC video encode through Media Foundation, which
    // dispatches to NVENC (NVIDIA), QuickSync (Intel) or VCN (AMD).
    "MediaFoundationVideoCapture",
    "MediaFoundationH264CbpEncoding",
    "MediaFoundationVP8Encoding",
    "MediaFoundationClearH264Encoding",
    // Linux: enable VAAPI encode/decode for H.264, VP8, VP9.
    "VaapiVideoEncoder",
    "VaapiVideoDecoder",
    "VaapiVideoDecodeLinuxGL",
    // Cross-platform: lets HW pipeline use NV12/multi-plane GPU buffers
    // instead of CPU-side conversion.
    "UseMultiPlaneFormatForHardwareVideoFrames",
    "UseMultiPlaneFormatForSoftwareVideo",
  ].join(","),
);
// Don't fight Chromium's IPC video decoder selection - leaving the default
// (in-GPU-process decode) lets the platform encoder accelerator initialise.
// WebRtcAllowInputVolumeAdjustment: Chromium otherwise rides your mic INPUT
// gain up/down automatically (OS-level AGC), which fights the user's own gain
// and makes the mic drift quieter - disabling it is what Discord does. On by
// default here; must be set before app-ready, so it's a launch switch.
app.commandLine.appendSwitch(
  "disable-features",
  ["UseChromeOSDirectVideoDecoder", "WebRtcAllowInputVolumeAdjustment"].join(","),
);

// Dev/test escape hatch: run a second instance with an isolated session.
// R3DVOICE_USER_DATA_DIR=/tmp/r3dvoice-b pnpm --filter @r3dvoice/client dev
// Must happen BEFORE requestSingleInstanceLock so the lock is keyed on the
// overridden userData path - otherwise both instances contend for the same
// default-path lock and the second silently quits.
// Pre-rename REDVOICE_* env vars still work (scripts/muscle memory).
for (const [oldKey, newKey] of [
  ["REDVOICE_USER_DATA_DIR", "R3DVOICE_USER_DATA_DIR"],
  ["REDVOICE_SPLASH_DEMO", "R3DVOICE_SPLASH_DEMO"],
] as const) {
  if (!process.env[newKey] && process.env[oldKey]) process.env[newKey] = process.env[oldKey];
}
if (process.env["R3DVOICE_USER_DATA_DIR"]) {
  app.setPath("userData", process.env["R3DVOICE_USER_DATA_DIR"]);
}

// Single-instance lock: a second `r3dvoice://…` launch funnels through
// `second-instance` instead of spawning another process.
const gotSingleInstanceLock = app.requestSingleInstanceLock();
if (!gotSingleInstanceLock) {
  app.quit();
  process.exit(0);
}

// When launched from a desktop-file or taskbar (no attached terminal),
// process.stdout/stderr are closed pipes. Any console.* write - ours or
// from a dep like electron-updater - throws EPIPE. Without these guards
// the main process crashes before the window opens.
function swallowEpipe(err: NodeJS.ErrnoException): void {
  if (err.code === "EPIPE") return;
  throw err;
}
process.stdout.on("error", swallowEpipe);
process.stderr.on("error", swallowEpipe);
process.on("uncaughtException", (err: NodeJS.ErrnoException) => {
  if (err.code === "EPIPE") return;
  // Re-throw anything else so we don't silently swallow real bugs.
  throw err;
});

// electron-vite exposes ELECTRON_RENDERER_URL in dev; absent in prod.
const RENDERER_DEV_URL = process.env["ELECTRON_RENDERER_URL"];

// Self-relaunch compatibility mode: if a prior session set compat mode, honor it.
try {
  const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
  const compatFlagPath = join(userData, "compat.flag");
  if (
    process.platform === "linux" &&
    existsSync(compatFlagPath) &&
    !process.argv.includes("--ozone-platform=x11")
  ) {
    app.commandLine.appendSwitch("ozone-platform", "x11");
  }
} catch {
  // Too early; skip. Flag will take effect on the next launch.
}

// Opt-in crash reporting. When enabled, dumps go to userData/Crashpad locally;
// no remote upload until/unless a submitURL is configured by the operator.
try {
  const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
  const crashFlagPath = join(userData, "crash-reporting.flag");
  if (existsSync(crashFlagPath)) {
    crashReporter.start({
      productName: "R3DVoice",
      companyName: "R3dWolfie",
      // Empty submitURL = local-only dumps. Operator can override later.
      submitURL: "",
      uploadToServer: false,
    });
  }
} catch {
  // Crash reporter init is best-effort; never block startup.
}

function appendCrashLog(message: string): void {
  const ts = new Date().toISOString();
  try {
    const fs = require("node:fs") as typeof import("node:fs");
    const logPath = join(app.getPath("userData"), "renderer-crash.log");
    // Rotate once past ~1 MB so a chatty/looping renderer can't grow it
    // without bound (keep one previous generation).
    try {
      if (fs.statSync(logPath).size > 1_000_000) {
        fs.renameSync(logPath, `${logPath}.old`);
      }
    } catch { /* no existing log yet */ }
    fs.appendFileSync(logPath, `[${ts}] ${message}\n`);
  } catch { /* logging best-effort */ }
}

async function createWindow(splash: BrowserWindow | null): Promise<BrowserWindow> {
  const iconPath = resolveIconPath();
  const bounds = getInitialWindowBounds();
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    // Floor the window size - below this the titlebar/controls compress into an
    // unusable sliver (custom-scale drag had no lower bound).
    minWidth: 900,
    minHeight: 600,
    ...(typeof bounds.x === "number" ? { x: bounds.x } : {}),
    ...(typeof bounds.y === "number" ? { y: bounds.y } : {}),
    backgroundColor: "#101014",
    show: false, // splash holds the screen until ready-to-show fires
    ...(iconPath && { icon: iconPath }),
    webPreferences: {
      preload: join(import.meta.dirname, "../preload/index.mjs"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  });

  // Prevent a chat link (or any renderer navigation) from loading a remote
  // page inside this preload-privileged window and exfiltrating the session
  // token. External links open in the user's real browser instead.
  hardenWebContents(win.webContents);

  trackWindowState(win);
  if (shouldStartMaximized()) {
    win.maximize();
  }

  win.once("ready-to-show", () => {
    sendSplashStatus(splash, { phase: "ready" });
    // Brief delay so the user sees "Ready" - feels intentional, not abrupt.
    setTimeout(() => {
      if (!win.isDestroyed()) win.show();
      closeSplash(splash);
    }, 300);
  });

  // Surface renderer crashes/hangs/errors. Without this, the user sees the
  // BrowserWindow chrome holding up an empty black canvas with no idea what
  // happened. Three layers cover the common failure modes:
  //   - render-process-gone:  process actually died
  //   - unresponsive:         renderer alive but stuck (infinite loop, deadlock)
  //   - app:log-error IPC:    uncaught JS errors / promise rejections
  win.webContents.on("render-process-gone", (_evt, details) => {
    appendCrashLog(`render-process-gone reason=${details.reason} exitCode=${details.exitCode}`);
    if (!app.isReady() || win.isDestroyed()) return;
    void dialog.showMessageBox(win, {
      type: "error",
      title: "R3DVoice - renderer crashed",
      message: `The window stopped rendering (${details.reason}).`,
      detail:
        `Exit code: ${details.exitCode}\n\n` +
        `A log was written to:\n${join(app.getPath("userData"), "renderer-crash.log")}\n\n` +
        `Click "Reload" to try again, or "Quit" to close R3DVoice.`,
      buttons: ["Reload", "Quit"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !win.isDestroyed()) {
        win.webContents.reload();
      } else {
        app.quit();
      }
    }).catch(() => { /* dialog dismissed */ });
  });
  win.on("unresponsive", () => {
    appendCrashLog("window unresponsive (renderer hung)");
    if (win.isDestroyed()) return;
    void dialog.showMessageBox(win, {
      type: "warning",
      title: "R3DVoice - window frozen",
      message: "The window stopped responding.",
      detail:
        `A log was written to:\n${join(app.getPath("userData"), "renderer-crash.log")}\n\n` +
        `Click "Reload" to recover, "Wait" to give it more time, or "Quit" to close.`,
      buttons: ["Reload", "Wait", "Quit"],
      defaultId: 0,
      cancelId: 1,
    }).then(({ response }) => {
      if (response === 0 && !win.isDestroyed()) {
        win.webContents.forcefullyCrashRenderer();
        // The render-process-gone handler will reload from there.
      } else if (response === 2) {
        app.quit();
      }
    }).catch(() => { /* dialog dismissed */ });
  });
  win.on("responsive", () => {
    appendCrashLog("window responsive again");
  });
  win.webContents.on("did-fail-load", (_evt, errorCode, errorDescription, validatedURL) => {
    appendCrashLog(`did-fail-load code=${errorCode} desc=${errorDescription} url=${validatedURL}`);
  });

  // Setting applicationMenu to null drops Electron's default accelerators
  // (Ctrl+R, Ctrl+Shift+I, F12) along with the menu bar - rebind them here.
  win.webContents.on("before-input-event", (_evt, input) => {
    if (input.type !== "keyDown") return;
    const key = input.key.toLowerCase();
    const ctrlLike = input.control || input.meta;
    if (ctrlLike && key === "r" && !input.shift) {
      win.webContents.reload();
    } else if (ctrlLike && key === "r" && input.shift) {
      win.webContents.reloadIgnoringCache();
    } else if ((ctrlLike && input.shift && key === "i") || key === "f12") {
      win.webContents.toggleDevTools();
    }
  });

  if (RENDERER_DEV_URL) {
    await win.loadURL(RENDERER_DEV_URL);
    win.webContents.openDevTools({ mode: "detach" });
  } else {
    await win.loadFile(join(import.meta.dirname, "../renderer/index.html"));
  }
  return win;
}

function registerIpcHandlers(): void {
  ipcMain.handle("auth:save-token", async (_event, token: unknown) => {
    if (typeof token !== "string") throw new Error("invalid token");
    await saveToken(token);
  });
  ipcMain.handle("auth:get-token", async () => getToken());
  ipcMain.handle("auth:clear-token", async () => clearToken());
  ipcMain.handle("app:platform", () => process.platform);
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("keybind:set-ptt", (_evt, accelerator: unknown) => {
    const acc = typeof accelerator === "string" && accelerator.length > 0 ? accelerator : null;
    setPttKeybind(acc, (pressed) => {
      BrowserWindow.getAllWindows().forEach((w) => {
        if (!w.webContents.isDestroyed()) w.webContents.send("keybind:ptt", pressed);
      });
    });
  });
  ipcMain.handle("app:set-compatibility-env", (_evt, enabled: unknown) => {
    const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
    const flagPath = join(userData, "compat.flag");
    if (enabled === true) {
      writeFileSync(flagPath, "1");
    } else {
      rmSync(flagPath, { force: true });
    }
  });
  ipcMain.handle("app:set-crash-reporting", (_evt, enabled: unknown) => {
    const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
    const flagPath = join(userData, "crash-reporting.flag");
    if (enabled === true) {
      writeFileSync(flagPath, "1");
    } else {
      rmSync(flagPath, { force: true });
    }
  });
  ipcMain.handle("app:open-crash-dumps", async () => {
    const userData = process.env["R3DVOICE_USER_DATA_DIR"] ?? app.getPath("userData");
    const dumpsDir = join(userData, "Crashpad");
    if (existsSync(dumpsDir)) {
      await shell.openPath(dumpsDir);
    } else {
      await shell.openPath(userData);
    }
  });
  ipcMain.handle("app:log-error", (_evt, line: unknown) => {
    if (typeof line !== "string") return;
    appendCrashLog(line.replace(/\n/g, " ⏎ "));
  });
  // macOS media-permission introspection. On non-mac platforms these APIs
  // are no-ops ("granted" / resolves true) so the renderer can call them
  // unconditionally without platform checks at every call site.
  ipcMain.handle("perm:media-status", (_evt, kind: unknown) => {
    if (process.platform !== "darwin") return "granted";
    if (kind !== "microphone" && kind !== "camera" && kind !== "screen") return "unknown";
    return systemPreferences.getMediaAccessStatus(kind);
  });
  ipcMain.handle("perm:ask-media", async (_evt, kind: unknown) => {
    if (process.platform !== "darwin") return true;
    if (kind !== "microphone" && kind !== "camera") return true;
    return systemPreferences.askForMediaAccess(kind);
  });
  ipcMain.handle("perm:open-mac-screen-settings", async () => {
    if (process.platform !== "darwin") return;
    await shell.openExternal(
      "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture",
    );
  });
  ipcMain.handle("shell:open-external", async (_evt, url: unknown) => {
    if (typeof url !== "string") return;
    // Only http(s) - prevents file:// or javascript: escapes.
    if (!/^https?:\/\//i.test(url)) return;
    await shell.openExternal(url);
  });
  ipcMain.handle("app:relaunch", () => {
    app.relaunch();
    app.exit(0);
  });
  // The required-update gate asks whether this build can self-update. True only
  // for a packaged build with the in-app updater active (standalone AppImage/
  // exe/dmg); AUR/deb set R3DVOICE_DISABLE_UPDATER and update via the package
  // manager, so the gate shows "run yay -Syu" instead of a Restart button.
  ipcMain.handle("updater:info", () => ({
    canSelfUpdate: app.isPackaged && !process.env["R3DVOICE_DISABLE_UPDATER"],
    // A pacman-managed Linux install (AUR wrapper sets R3DVOICE_DISABLE_UPDATER):
    // it can auto-install the release .pkg.tar.zst via `pkexec pacman -U`.
    pacman: process.platform === "linux" && !!process.env["R3DVOICE_DISABLE_UPDATER"],
  }));

  // Download the release .pkg.tar.zst and install it with a single GUI password
  // prompt (`pkexec pacman -U`). On success the app relaunches into the new
  // version. Used by both auto-update-on-launch and the manual update controls
  // for pacman installs (1 password, no terminal, vs the yay -Syu fallback).
  ipcMain.handle("updater:pacman-install", async (_evt, version: unknown) => {
    if (typeof version !== "string") return { ok: false, error: "unsupported" };
    const r = await installPacmanPackage(version);
    if (r.ok) {
      app.relaunch();
      app.exit(0);
    }
    return r;
  });

  // The renderer mirrors autoUpdate + serverUrl here so the splash-phase
  // auto-updater (which runs before the renderer loads) can read last-known
  // values on the next launch.
  ipcMain.handle("updater:set-launch-prefs", (_evt, autoUpdate: unknown, serverUrl: unknown) => {
    writeLaunchPrefs({
      autoUpdate: autoUpdate !== false,
      serverUrl: typeof serverUrl === "string" ? serverUrl : null,
    });
    return { ok: true };
  });

  // AUR/pacman installs can't self-update (/opt is root-owned, and the app must
  // not fight pacman). Best effort so "Update" is one click, not copy-paste:
  // launch the user's package manager in a real terminal. Returns launched:false
  // if no terminal is found, so the UI can fall back to showing the command.
  ipcMain.handle("updater:run-package-update", async () => {
    const script =
      "yay -Syu; echo; echo '--- update finished - restart R3DVoice to apply. ---'; read -n1 -s -r -p 'Press any key to close…'";
    const term = process.env["TERMINAL"];
    const candidates: Array<{ bin: string; args: string[] }> = [
      ...(term ? [{ bin: term, args: ["-e", "bash", "-lc", script] }] : []),
      { bin: "konsole", args: ["-e", "bash", "-lc", script] },
      { bin: "gnome-terminal", args: ["--", "bash", "-lc", script] },
      { bin: "alacritty", args: ["-e", "bash", "-lc", script] },
      { bin: "kitty", args: ["bash", "-lc", script] },
      { bin: "foot", args: ["bash", "-lc", script] },
      { bin: "wezterm", args: ["start", "--", "bash", "-lc", script] },
      { bin: "xterm", args: ["-e", "bash", "-lc", script] },
      { bin: "x-terminal-emulator", args: ["-e", "bash", "-lc", script] },
    ];
    for (const c of candidates) {
      const ok = await new Promise<boolean>((resolve) => {
        try {
          const child = spawn(c.bin, c.args, { detached: true, stdio: "ignore" });
          child.on("error", () => resolve(false));
          child.on("spawn", () => {
            child.unref();
            resolve(true);
          });
        } catch {
          resolve(false);
        }
      });
      if (ok) return { launched: true, terminal: c.bin };
    }
    return { launched: false };
  });
}

let mainWindow: BrowserWindow | null = null;

// Hot launch: OS delivers the URL through second-instance argv (Linux/Windows).
app.on("second-instance", (_event, argv) => {
  const link = extractDeepLinkFromArgv(argv);
  if (link) dispatchDeepLink(link, mainWindow);
  if (mainWindow) {
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  }
});

// macOS delivers deep-link clicks via open-url, not argv.
app.on("open-url", (event, url) => {
  event.preventDefault();
  const link = parseDeepLink(url);
  if (link) dispatchDeepLink(link, mainWindow);
});

app.whenReady().then(async () => {
  registerIpcHandlers();
  registerScreenPickerHandlers();
  registerDeepLinkHandlers();
  registerSystemAudioCaptureHandlers();
  registerLinuxAudioRoutingHandlers();
  registerNotificationsHandler();
  writeDesktopEntry();

  // Dev-only: R3DVOICE_SPLASH_DEMO=1 cycles every splash phase slowly and
  // skips the main window so you can inspect the splash in isolation.
  if (process.env["R3DVOICE_SPLASH_DEMO"]) {
    const splash = openSplashWindow();
    splash.webContents.once("did-finish-load", () => {
      const steps: Array<[Parameters<typeof sendSplashStatus>[1], number]> = [
        [{ phase: "initializing" }, 2000],
        [{ phase: "checking" }, 2000],
        [{ phase: "available" }, 2000],
        [{ phase: "downloading", percent: 15 }, 600],
        [{ phase: "downloading", percent: 45 }, 600],
        [{ phase: "downloading", percent: 80 }, 600],
        [{ phase: "downloading", percent: 100 }, 600],
        [{ phase: "downloaded" }, 2000],
        [{ phase: "loading" }, 2000],
        [{ phase: "ready" }, 30000],
      ];
      let t = 0;
      for (const [status, delay] of steps) {
        setTimeout(() => sendSplashStatus(splash, status), t);
        t += delay;
      }
    });
    return;
  }

  // Open splash FIRST so the user sees feedback while the renderer + any
  // update check are warming up.
  const splash = openSplashWindow();
  splash.webContents.once("did-finish-load", () => {
    sendSplashStatus(splash, { phase: "initializing" });
  });

  // Block opening the main window until the update flow settles. If an
  // update was downloaded we silent-install + relaunch; createWindow never
  // runs because the process is on its way out.
  const updateResult = await initAutoUpdate(splash);
  if (updateResult.kind === "installing") return;

  // On Wayland, xdg-desktop-portal is the picker - the OS won't let any app
  // enumerate screens without the user clicking in the portal dialog first.
  // So our custom picker would stack on top of the OS picker and hang on
  // "Loading sources…". Skip our UI on Wayland, defer entirely to the portal.
  const isWayland =
    process.platform === "linux" &&
    (process.env["XDG_SESSION_TYPE"] === "wayland" ||
      Boolean(process.env["WAYLAND_DISPLAY"]));

  session.defaultSession.setDisplayMediaRequestHandler(async (request, callback) => {
    // Audio-only request (the in-room "Share audio" toggle on Windows when
    // the native filter isn't available). Skip the screen picker - the user
    // doesn't want to pick a window, they want loopback audio. macOS/Linux
    // can't deliver system audio without a video source, so we return empty.
    if (request.audioRequested && !request.videoRequested) {
      if (process.platform === "win32") {
        callback({ audio: "loopback" });
      } else {
        callback({});
      }
      return;
    }

    // Any throw below (getSources rejecting on the X11 path, picker window
    // dying) must still settle the request - otherwise the renderer hangs on
    // "Loading sources…" forever. Deny (callback({})) on error.
    try {
      if (isWayland) {
        // Portal prompts the user; getSources returns just the chosen source.
        const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
        if (sources.length === 0) {
          callback({});
          return;
        }
        callback({ video: sources[0]! });
        return;
      }

      // Everywhere else (X11, macOS, Windows): show our in-app picker
      const sourceId = await openScreenPicker();
      if (!sourceId) {
        callback({});
        return;
      }
      const sources = await desktopCapturer.getSources({ types: ["screen", "window"] });
      const picked = sources.find((s) => s.id === sourceId);
      if (!picked) {
        callback({});
        return;
      }
      if (process.platform === "win32") {
        callback({ video: picked, audio: "loopback" });
      } else {
        callback({ video: picked });
      }
    } catch (err) {
      appendCrashLog(`display-media handler failed: ${err instanceof Error ? err.message : String(err)}`);
      callback({});
    }
  }, {
    // On Wayland (and macOS 15+) let Electron route getDisplayMedia straight to
    // the OS portal - one native dialog. Without this, requesting both "screen"
    // and "window" source types via desktopCapturer.getSources opens the KDE
    // portal twice (once per type). The handler above still runs as the fallback
    // on X11/Windows/older macOS where no system picker exists.
    useSystemPicker: true,
  });

  mainWindow = await createWindow(splash);

  // Cold launch via `r3dvoice://…` - URL is in process.argv; stash as pending
  // so the renderer picks it up after it finishes loading.
  const coldLink = extractDeepLinkFromArgv(process.argv);
  if (coldLink) dispatchDeepLink(coldLink, mainWindow);

  app.on("activate", async () => {
    if (BrowserWindow.getAllWindows().length === 0) mainWindow = await createWindow(null);
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") app.quit();
});

app.on("will-quit", () => {
  teardownKeybinds();
  stopSystemAudioCapture();
});
