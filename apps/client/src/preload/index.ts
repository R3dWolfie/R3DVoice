import { contextBridge, ipcRenderer } from "electron";
import type { R3DVoiceBridge, SplashStatus, DeepLinkEvent, NotifyPayload } from "../shared/bridge-types.js";

const bridge: R3DVoiceBridge = {
  saveToken: (token) => ipcRenderer.invoke("auth:save-token", token),
  getToken: () => ipcRenderer.invoke("auth:get-token"),
  clearToken: () => ipcRenderer.invoke("auth:clear-token"),
  platform: () => process.platform,
  getAppVersion: () => ipcRenderer.invoke("app:get-version"),
  listScreenSources: () => ipcRenderer.invoke("screen-picker:list"),
  selectScreenSource: (sourceId) => ipcRenderer.invoke("screen-picker:select", sourceId),
  cancelScreenPicker: () => ipcRenderer.invoke("screen-picker:cancel"),
  setPttKeybind: (accelerator) => ipcRenderer.invoke("keybind:set-ptt", accelerator),
  setCompatibilityEnv: (enabled) => ipcRenderer.invoke("app:set-compatibility-env", enabled),
  relaunch: () => ipcRenderer.invoke("app:relaunch"),
  updaterInfo: () => ipcRenderer.invoke("updater:info"),
  runPackageUpdate: () => ipcRenderer.invoke("updater:run-package-update"),
  pacmanInstall: (version) => ipcRenderer.invoke("updater:pacman-install", version),
  onPttEvent: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, pressed: boolean): void => cb(pressed);
    ipcRenderer.on("keybind:ptt", handler);
    return () => ipcRenderer.off("keybind:ptt", handler);
  },
  onSplashStatus: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, status: SplashStatus): void => cb(status);
    ipcRenderer.on("splash:status", handler);
    return () => ipcRenderer.off("splash:status", handler);
  },
  onDeepLink: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, link: DeepLinkEvent): void => cb(link);
    ipcRenderer.on("deep-link", handler);
    // Ask main for any deep link queued before we subscribed (cold-start case).
    void ipcRenderer.invoke("deep-link:consume-pending").then((link: DeepLinkEvent | null) => {
      if (link) cb(link);
    });
    return () => ipcRenderer.off("deep-link", handler);
  },
  getMediaPermission: (kind) => ipcRenderer.invoke("perm:media-status", kind),
  askMediaPermission: (kind) => ipcRenderer.invoke("perm:ask-media", kind),
  openMacScreenSettings: () => ipcRenderer.invoke("perm:open-mac-screen-settings"),
  openExternal: (url) => ipcRenderer.invoke("shell:open-external", url),
  setCrashReporting: (enabled) => ipcRenderer.invoke("app:set-crash-reporting", enabled),
  openCrashDumps: () => ipcRenderer.invoke("app:open-crash-dumps"),
  logError: (line) => ipcRenderer.invoke("app:log-error", line),
  startSystemAudioCapture: (options) => ipcRenderer.invoke("system-audio:start", options),
  stopSystemAudioCapture: () => ipcRenderer.invoke("system-audio:stop"),
  systemAudioFormat: () => ipcRenderer.invoke("system-audio:format"),
  listWindowsAudioSessions: () => ipcRenderer.invoke("system-audio:list-sessions"),
  onSystemAudioChunk: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, chunk: Uint8Array): void => cb(chunk);
    ipcRenderer.on("system-audio:chunk", handler);
    return () => ipcRenderer.off("system-audio:chunk", handler);
  },
  onSystemAudioEnded: (cb) => {
    const handler = (): void => cb();
    ipcRenderer.on("system-audio:ended", handler);
    return () => ipcRenderer.off("system-audio:ended", handler);
  },
  enableLinuxAudioRouting: (options) => ipcRenderer.invoke("linux-audio-routing:enable", options),
  disableLinuxAudioRouting: () => ipcRenderer.invoke("linux-audio-routing:disable"),
  listLinuxAudioSources: () => ipcRenderer.invoke("linux-audio-routing:list-sources"),
  onInviteCode: (cb) => {
    const handler = (_evt: Electron.IpcRendererEvent, link: DeepLinkEvent): void => {
      if (link.type === "invite-code") cb(link.code);
    };
    ipcRenderer.on("deep-link", handler);
    // Replay any pending deep link queued before we subscribed (cold-start case).
    void ipcRenderer.invoke("deep-link:consume-pending").then((link: DeepLinkEvent | null) => {
      if (link && link.type === "invite-code") cb(link.code);
    });
    return () => ipcRenderer.off("deep-link", handler);
  },
  notify: (payload: NotifyPayload) => ipcRenderer.invoke("notify", payload),
};

contextBridge.exposeInMainWorld("r3dvoice", bridge);
