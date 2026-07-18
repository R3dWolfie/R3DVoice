// Typed interface for the window.r3dvoice bridge exposed to the renderer.
// Kept in shared/ so both preload (exposes it) and renderer (consumes it) agree.

export type SplashPhase =
  | "initializing"
  | "checking"
  | "available"
  | "downloading"
  | "downloaded"
  | "loading"
  | "ready"
  | "error";

export interface SplashStatus {
  phase: SplashPhase;
  /** Download progress percent (0..100) when phase is "downloading". */
  percent?: number;
  /** Optional human-readable message; overrides the default per-phase label. */
  message?: string;
}

export type MediaPermissionKind = "microphone" | "camera" | "screen";
export type MediaPermissionStatus = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

export interface R3DVoiceBridge {
  /** Store a session token encrypted at rest via Electron safeStorage. */
  saveToken(token: string): Promise<void>;
  /** Retrieve the stored session token, or null if none/undecryptable. */
  getToken(): Promise<string | null>;
  /** Remove the stored session token. */
  clearToken(): Promise<void>;
  /** Platform string: "darwin" | "linux" | "win32". */
  platform(): string;
  /** Get the application version string. */
  getAppVersion(): Promise<string>;
  listScreenSources(): Promise<Array<{ id: string; name: string; thumbnailDataUrl: string }>>;
  selectScreenSource(sourceId: string): Promise<void>;
  cancelScreenPicker(): Promise<void>;
  setPttKeybind(accelerator: string | null): Promise<void>;
  onPttEvent(cb: (pressed: boolean) => void): () => void;
  setCompatibilityEnv(enabled: boolean): Promise<void>;
  relaunch(): Promise<void>;
  /**
   * Updater capability. canSelfUpdate is true only for a packaged build whose
   * in-app updater is active (standalone AppImage/exe/dmg) — false for AUR/deb
   * (pacman/apt own updates) and for web. Drives the required-update gate's UX.
   */
  updaterInfo(): Promise<{ canSelfUpdate: boolean }>;
  /**
   * Launch the system package manager (yay -Syu) in a terminal for installs
   * that can't self-update (AUR/deb). Resolves launched:false when no terminal
   * emulator is found, so the UI can fall back to showing the command.
   */
  runPackageUpdate(): Promise<{ launched: boolean; terminal?: string }>;
  /**
   * Subscribe to splash-window status updates from the main process.
   * Used by the splash renderer; harmless to call from the main window.
   * Returns an unsubscribe function.
   */
  onSplashStatus(cb: (status: SplashStatus) => void): () => void;
  /**
   * Subscribe to deep-link events from the OS (r3dvoice://…).
   * Returns an unsubscribe function.
   */
  onDeepLink(cb: (link: DeepLinkEvent) => void): () => void;
  /** macOS media permission status. On non-mac platforms returns "granted". */
  getMediaPermission(kind: MediaPermissionKind): Promise<MediaPermissionStatus>;
  /** macOS mic/camera permission prompt. No-op on non-mac; screen is not promptable. */
  askMediaPermission(kind: "microphone" | "camera"): Promise<boolean>;
  /** macOS: open System Settings → Privacy → Screen Recording. No-op elsewhere. */
  openMacScreenSettings(): Promise<void>;
  /** Open an http(s) URL in the default browser. Other schemes are rejected. */
  openExternal(url: string): Promise<void>;
  /** Toggle opt-in crash reporting (takes effect on next launch). */
  setCrashReporting(enabled: boolean): Promise<void>;
  /** Open the OS file manager at the local crash-dump directory. */
  openCrashDumps(): Promise<void>;
  /** Append a renderer-side error/warning to userData/renderer-crash.log. */
  logError(line: string): Promise<void>;
  /**
   * Start the native system-audio capture helper (Windows-only). Pass
   * `includePid` to capture only that process's audio (per-app share);
   * otherwise the helper captures system mix excluding R3DVoice itself.
   * Resolves to "started" when PCM is flowing, or "unsupported" if the
   * binary isn't bundled / OS build doesn't support PROCESS_LOOPBACK_MODE /
   * activation failed.
   */
  startSystemAudioCapture(options?: { includePid?: number }): Promise<"started" | "unsupported">;
  /** Windows-only: list active audio sessions for the share-audio source picker. */
  listWindowsAudioSessions(): Promise<WindowsAudioSessionInfo[]>;
  /** Stop a running system-audio capture session. No-op if none. */
  stopSystemAudioCapture(): Promise<void>;
  /** PCM format the helper emits — needed to reconstruct a MediaStream. */
  systemAudioFormat(): Promise<SystemAudioFormat>;
  /** Subscribe to PCM chunks from the helper. Returns an unsubscribe. */
  onSystemAudioChunk(cb: (chunk: Uint8Array) => void): () => void;
  /** Notified once when the helper exits (helper crashed or was stopped). */
  onSystemAudioEnded(cb: () => void): () => void;
  /**
   * Linux-only: set up routing so screenshare audio capture excludes
   * R3DVoice's own playback. Pass `includeProcessId` to capture only one
   * specific app instead of the system-wide-minus-self default.
   */
  enableLinuxAudioRouting(
    options?: { includeProcessId?: string },
  ): Promise<{ monitorDeviceDescription: string } | null>;
  /** Tear down the routing set up by enableLinuxAudioRouting. */
  disableLinuxAudioRouting(): Promise<void>;
  /** Linux-only: list audio-producing apps for the share-audio source picker. */
  listLinuxAudioSources(): Promise<LinuxAudioSourceSummary[]>;
  /**
   * Subscribe to invite deep-link events (r3dvoice://invite/<code>).
   * Returns an unsubscribe function.
   */
  onInviteCode(cb: (code: string) => void): () => void;
  /** Fire an OS-level notification via Electron's Notification API. */
  notify(payload: NotifyPayload): Promise<void>;
}

export interface LinuxAudioSourceSummary {
  nodeName: string;
  appName: string;
  processId: string;
  iconName?: string;
}

export interface WindowsAudioSessionInfo {
  pid: number;
  imageName: string;
  displayName: string;
}

export interface SystemAudioFormat {
  sampleRate: number;
  channels: number;
  bitsPerSample: number;
}

export type DeepLinkEvent =
  | { type: "join-room"; roomId: string }
  | { type: "invite-code"; code: string };

export interface NotifyPayload {
  title: string;
  body: string;
  silent?: boolean;
}
