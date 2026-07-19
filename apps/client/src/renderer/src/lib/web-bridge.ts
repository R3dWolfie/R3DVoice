import type {
  R3DVoiceBridge,
  MediaPermissionKind,
  MediaPermissionStatus,
} from "../../../shared/bridge-types.js";

declare const __APP_VERSION__: string;

const TOKEN_KEY = "r3dvoice.web.token";

const noopUnsub = (): (() => void) => () => {};

function permissionName(kind: MediaPermissionKind): PermissionName | null {
  // "microphone"/"camera" are valid PermissionName values in Chromium and
  // recent Firefox; cast because TS's lib.dom lags behind.
  if (kind === "microphone" || kind === "camera") return kind as PermissionName;
  return null;
}

// Browser implementation of the window.r3dvoice bridge. Same renderer bundle
// runs in Electron (preload provides the real bridge before any script) and
// in a plain browser tab (this shim fills the gap):
//   - token storage → localStorage (the web tab has no OS keychain)
//   - screenshare picker → the browser's native getDisplayMedia UI
//   - global PTT, system-audio capture, crash dumps, deep links → unavailable
function makeWebBridge(): R3DVoiceBridge {
  return {
    saveToken: (token) => {
      localStorage.setItem(TOKEN_KEY, token);
      return Promise.resolve();
    },
    getToken: () => Promise.resolve(localStorage.getItem(TOKEN_KEY)),
    clearToken: () => {
      localStorage.removeItem(TOKEN_KEY);
      return Promise.resolve();
    },
    platform: () => "web",
    getAppVersion: () =>
      Promise.resolve(typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "web"),
    listScreenSources: () => Promise.resolve([]),
    selectScreenSource: () => Promise.resolve(),
    cancelScreenPicker: () => Promise.resolve(),
    setPttKeybind: () => Promise.resolve(),
    onPttEvent: noopUnsub,
    setCompatibilityEnv: () => Promise.resolve(),
    relaunch: () => {
      window.location.reload();
      return Promise.resolve();
    },
    updaterInfo: () => Promise.resolve({ canSelfUpdate: false, pacman: false }),
    runPackageUpdate: () => Promise.resolve({ launched: false }),
    pacmanInstall: () => Promise.resolve({ ok: false }),
    onSplashStatus: noopUnsub,
    onDeepLink: noopUnsub,
    getMediaPermission: async (kind): Promise<MediaPermissionStatus> => {
      const name = permissionName(kind);
      if (!name) return "granted"; // screen: the browser prompts at share time
      try {
        const st = await navigator.permissions.query({ name });
        if (st.state === "granted") return "granted";
        if (st.state === "denied") return "denied";
        return "not-determined";
      } catch {
        return "unknown";
      }
    },
    askMediaPermission: async (kind) => {
      try {
        const stream = await navigator.mediaDevices.getUserMedia(
          kind === "microphone" ? { audio: true } : { video: true },
        );
        stream.getTracks().forEach((t) => t.stop());
        return true;
      } catch {
        return false;
      }
    },
    openMacScreenSettings: () => Promise.resolve(),
    openExternal: (url) => {
      if (/^https?:\/\//.test(url)) window.open(url, "_blank", "noopener");
      return Promise.resolve();
    },
    setCrashReporting: () => Promise.resolve(),
    openCrashDumps: () => Promise.resolve(),
    logError: (line) => {
      // eslint-disable-next-line no-console
      console.info("[r3dvoice]", line);
      return Promise.resolve();
    },
    startSystemAudioCapture: () => Promise.resolve("unsupported" as const),
    listWindowsAudioSessions: () => Promise.resolve([]),
    stopSystemAudioCapture: () => Promise.resolve(),
    systemAudioFormat: () =>
      Promise.resolve({ sampleRate: 48000, channels: 2, bitsPerSample: 16 }),
    onSystemAudioChunk: noopUnsub,
    onSystemAudioEnded: noopUnsub,
    enableLinuxAudioRouting: () => Promise.resolve(null),
    disableLinuxAudioRouting: () => Promise.resolve(),
    listLinuxAudioSources: () => Promise.resolve([]),
    onInviteCode: noopUnsub,
    notify: async (payload) => {
      try {
        if (!("Notification" in window)) return;
        if (Notification.permission === "default") await Notification.requestPermission();
        if (Notification.permission === "granted") {
          new Notification(payload.title, { body: payload.body, silent: payload.silent ?? false });
        }
      } catch {
        /* notifications are best-effort on web */
      }
    },
  };
}

/** True when running in a plain browser tab (no Electron preload bridge). */
export function isWebBuild(): boolean {
  return typeof window !== "undefined" && window.r3dvoice === undefined;
}

/** Install the browser bridge if the Electron preload didn't provide one. */
export function installWebBridgeIfNeeded(): void {
  if (isWebBuild()) {
    (window as unknown as { r3dvoice: R3DVoiceBridge }).r3dvoice = makeWebBridge();
  }
}
