import { createStore, type StoreApi } from "zustand/vanilla";

export interface PrefsStorage {
  read(): string | null;
  write(value: string): void;
}

export type Resolution = "144p" | "240p" | "480p" | "720p" | "1080p" | "1440p" | "4K";
export type FrameRate = 30 | 60;
export type NoiseSuppressionLevel = "off" | "low" | "high";
export type InputProfile = "voice-isolation" | "studio" | "custom";

/** Deck 3.6 presets: Light · Dark · Grey · Match OS. */
export type ThemePreset = "light" | "dark" | "grey" | "system";
/** Camera preview/capture resolution (Settings › Devices › Video, 3.1). */
export type CameraResolution = "144p" | "240p" | "480p" | "720p" | "1080p" | "1440p";
/** Default room-notification behavior (Settings › Notifications, 3.7). */
export type RoomNotifDefault = "all" | "mentions" | "none";

export interface PrefsState {
  theme: ThemePreset;
  /**
   * Per-token theme overrides (3.6 token editor): CSS custom property name
   * ("--bg") → color value ("#fafafa"). Applied as inline styles on <html>
   * so they win over any preset block; reapplied on boot by App.
   */
  themeOverrides: Record<string, string>;
  dmBanners: boolean;
  dmPreviews: boolean;
  /** 3.7 - default notification behavior for rooms without an explicit override. */
  roomNotifDefault: RoomNotifDefault;
  /** 3.7 - quiet hours suppress all banners + sounds (bell panel still fills). */
  quietHoursEnabled: boolean;
  /** "HH:MM" local time, 24h. */
  quietHoursStart: string;
  /** "HH:MM" local time, 24h. */
  quietHoursEnd: string;
  /** 3.1 Video - camera preview/capture resolution. */
  cameraResolution: CameraResolution;
  /** 3.1 Video - mirror the local preview horizontally (never what others see). */
  cameraMirror: boolean;
  /** Mono input: force-mono capture + downmix (left-only interfaces). */
  monoInput: boolean;
  /** Mono output: both ears get the same downmixed signal. */
  monoOutput: boolean;
  /** Desktop: auto-install updates on launch (packaged self-updating builds). */
  autoUpdate: boolean;
  /** User chose "Never" on the update popup - silence it permanently. */
  hideUpdatePopup: boolean;
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  cameraDeviceId: string | null;
  resolution: Resolution;
  frameRate: FrameRate;
  shareAudio: boolean;
  pttKeybind: string | null;
  muteKeybind: string | null;
  deafenKeybind: string | null;
  shareScreenKeybind: string | null;
  openSettingsKeybind: string | null;
  leaveRoomKeybind: string | null;
  compatibilityMode: boolean;
  crashReporting: boolean;
  showDiagnostics: boolean;
  /** Toast when someone joins/leaves a call you're in (no sound assets yet). */
  joinLeaveToasts: boolean;
  noiseSuppression: NoiseSuppressionLevel;
  echoCancellation: boolean;
  autoGainControl: boolean;
  micGain: number;
  /** Discord-style input preset; "custom" exposes the individual dials. */
  inputProfile: InputProfile;
  /** Advanced Voice Activity: gate mic transmission on input level. */
  vadEnabled: boolean;
  /** VAD threshold, 0..1 - mic only transmits when level exceeds this. */
  inputSensitivity: number;
  serverUrl: string;
  /** Room IDs the user has starred - surfaced by future Lobby UX. */
  favoriteRoomIds: string[];
  /** Per-participant voice volume map (1.0 = unity). Persists across sessions. */
  participantVolumes: Record<string, number>;
  /** Per-participant screen-audio volume map (1.0 = unity). Persists across sessions. */
  participantScreenVolumes: Record<string, number>;

  setTheme(theme: ThemePreset): void;
  /** Replace the whole override map (empty object = reset to preset). */
  setThemeOverrides(overrides: Record<string, string>): void;
  setDmBanners(v: boolean): void;
  setDmPreviews(v: boolean): void;
  setRoomNotifDefault(v: RoomNotifDefault): void;
  setQuietHoursEnabled(v: boolean): void;
  setQuietHoursStart(v: string): void;
  setQuietHoursEnd(v: string): void;
  setCameraResolution(v: CameraResolution): void;
  setCameraMirror(v: boolean): void;
  setMonoInput(v: boolean): void;
  setMonoOutput(v: boolean): void;
  setMicDeviceId(id: string | null): void;
  setSpeakerDeviceId(id: string | null): void;
  setCameraDeviceId(id: string | null): void;
  setResolution(r: Resolution): void;
  setFrameRate(f: FrameRate): void;
  setShareAudio(v: boolean): void;
  setPttKeybind(k: string | null): void;
  setMuteKeybind(k: string | null): void;
  setDeafenKeybind(k: string | null): void;
  setShareScreenKeybind(k: string | null): void;
  setOpenSettingsKeybind(k: string | null): void;
  setLeaveRoomKeybind(k: string | null): void;
  setCompatibilityMode(v: boolean): void;
  setCrashReporting(v: boolean): void;
  setShowDiagnostics(v: boolean): void;
  setAutoUpdate(v: boolean): void;
  setHideUpdatePopup(v: boolean): void;
  setJoinLeaveToasts(v: boolean): void;
  setNoiseSuppression(v: NoiseSuppressionLevel): void;
  setEchoCancellation(v: boolean): void;
  setAutoGainControl(v: boolean): void;
  setMicGain(v: number): void;
  setInputProfile(v: InputProfile): void;
  setVadEnabled(v: boolean): void;
  setInputSensitivity(v: number): void;
  setServerUrl(u: string): void;
  toggleFavoriteRoom(id: string): void;
  setParticipantVolume(id: string, volume: number): void;
  setParticipantScreenVolume(id: string, volume: number): void;

  // ── feat(inroom): per-participant voice gain (0–200% in-call volume) ──────
  /**
   * Per-participant voice GAIN multiplier (>1 boost, up to ~2.0). Kept apart
   * from participantVolumes because element.volume is clamped to ≤1; the 100–
   * 200% band rides a Web Audio GainNode instead. 1.0 = no boost.
   */
  participantGains: Record<string, number>;
  setParticipantGain(id: string, gain: number): void;
}

/**
 * Deck 3.2 default keybinds - the single source of truth shared by the store
 * DEFAULTS below and Settings › Keybinds "Reset to defaults".
 */
export const KEYBIND_DEFAULTS: {
  pttKeybind: string | null;
  muteKeybind: string | null;
  deafenKeybind: string | null;
  shareScreenKeybind: string | null;
  openSettingsKeybind: string | null;
  leaveRoomKeybind: string | null;
} = {
  pttKeybind: "Control+Space",
  muteKeybind: "Control+Shift+M",
  deafenKeybind: null,
  shareScreenKeybind: "Control+Shift+E",
  openSettingsKeybind: "Control+,",
  leaveRoomKeybind: null,
};

const DEFAULTS = {
  theme: "light" as ThemePreset,
  themeOverrides: {} as Record<string, string>,
  dmBanners: true,
  dmPreviews: true,
  roomNotifDefault: "all" as RoomNotifDefault,
  quietHoursEnabled: false,
  quietHoursStart: "22:00",
  quietHoursEnd: "08:00",
  cameraResolution: "720p" as CameraResolution,
  cameraMirror: false,
  monoInput: false,
  monoOutput: false,
  autoUpdate: true,
  hideUpdatePopup: false,
  micDeviceId: null as string | null,
  speakerDeviceId: null as string | null,
  cameraDeviceId: null as string | null,
  resolution: "1080p" as Resolution,
  frameRate: 30 as FrameRate,
  shareAudio: true,
  // Deck 3.2 defaults (⌘ ≈ Control cross-platform). Ghost + Leave ship unbound.
  pttKeybind: KEYBIND_DEFAULTS.pttKeybind,
  muteKeybind: KEYBIND_DEFAULTS.muteKeybind,
  deafenKeybind: KEYBIND_DEFAULTS.deafenKeybind,
  shareScreenKeybind: KEYBIND_DEFAULTS.shareScreenKeybind,
  openSettingsKeybind: KEYBIND_DEFAULTS.openSettingsKeybind,
  leaveRoomKeybind: KEYBIND_DEFAULTS.leaveRoomKeybind,
  compatibilityMode: false,
  crashReporting: false,
  showDiagnostics: false,
  joinLeaveToasts: true,
  noiseSuppression: "high" as NoiseSuppressionLevel,
  echoCancellation: true,
  // Fresh installs land on the "Voice Isolation" profile (strong NS + AEC +
  // AGC + voice-activity gating) for clean Discord-grade audio out of the box.
  // Existing users keep whatever they had persisted.
  autoGainControl: true,
  micGain: 1.0,
  inputProfile: "voice-isolation" as InputProfile,
  vadEnabled: true,
  inputSensitivity: 0.12,
  // Server URL default, in priority order:
  //   1. VITE_SERVER_URL at build time (dev/self-host override, fresh profiles)
  //   2. web build (no Electron preload bridge at module-eval time): the page's
  //      own origin - the server serving the SPA IS the API server
  //   3. Electron: the canonical hosted instance
  // Persisted prefs always take precedence after first run.
  serverUrl:
    (typeof import.meta !== "undefined" &&
      (import.meta as unknown as { env?: Record<string, string | undefined> }).env?.["VITE_SERVER_URL"]) ||
    (typeof window !== "undefined" &&
    (window as { r3dvoice?: unknown }).r3dvoice === undefined &&
    /^https?:$/.test(window.location.protocol)
      ? window.location.origin
      : "") ||
    "https://voice.r3dwolfie.com",
  favoriteRoomIds: [] as string[],
  participantVolumes: {} as Record<string, number>,
  participantScreenVolumes: {} as Record<string, number>,
  // feat(inroom): per-participant voice gain (>1 boost) - see PrefsState.
  participantGains: {} as Record<string, number>,
};

// LiveKit setVolume → HTMLMediaElement.volume which throws if outside [0, 1].
// Older builds had a 0..200% slider; values >1 in storage now crash remotes
// on track-subscribe. Migrate at load time so it can never reach setVolume.
function clampVolumeMap(raw: unknown): Record<string, number> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, number> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    const n = typeof v === "number" && Number.isFinite(v) ? v : 1;
    out[k] = n < 0 ? 0 : n > 1 ? 1 : n;
  }
  return out;
}

/** Keep only string→string entries whose key looks like a CSS custom property. */
function sanitizeThemeOverrides(raw: unknown): Record<string, string> {
  if (!raw || typeof raw !== "object") return {};
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (typeof v === "string" && k.startsWith("--")) out[k] = v;
  }
  return out;
}

function load(storage: PrefsStorage): typeof DEFAULTS {
  const raw = storage.read();
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = { ...DEFAULTS, ...parsed };
    merged.participantVolumes = clampVolumeMap(parsed.participantVolumes);
    merged.participantScreenVolumes = clampVolumeMap(parsed.participantScreenVolumes);
    merged.themeOverrides = sanitizeThemeOverrides(parsed.themeOverrides);
    return merged;
  } catch {
    return { ...DEFAULTS };
  }
}

export function createPrefsStore(storage: PrefsStorage): StoreApi<PrefsState> {
  const initial = load(storage);

  function persistFromState(state: PrefsState): void {
    const payload = {
      micDeviceId: state.micDeviceId,
      speakerDeviceId: state.speakerDeviceId,
      cameraDeviceId: state.cameraDeviceId,
      resolution: state.resolution,
      frameRate: state.frameRate,
      shareAudio: state.shareAudio,
      pttKeybind: state.pttKeybind,
      muteKeybind: state.muteKeybind,
      deafenKeybind: state.deafenKeybind,
      shareScreenKeybind: state.shareScreenKeybind,
      openSettingsKeybind: state.openSettingsKeybind,
      leaveRoomKeybind: state.leaveRoomKeybind,
      compatibilityMode: state.compatibilityMode,
      crashReporting: state.crashReporting,
      showDiagnostics: state.showDiagnostics,
      joinLeaveToasts: state.joinLeaveToasts,
      noiseSuppression: state.noiseSuppression,
      echoCancellation: state.echoCancellation,
      autoGainControl: state.autoGainControl,
      micGain: state.micGain,
      inputProfile: state.inputProfile,
      vadEnabled: state.vadEnabled,
      inputSensitivity: state.inputSensitivity,
      serverUrl: state.serverUrl,
      theme: state.theme,
      themeOverrides: state.themeOverrides,
      dmBanners: state.dmBanners,
      dmPreviews: state.dmPreviews,
      roomNotifDefault: state.roomNotifDefault,
      quietHoursEnabled: state.quietHoursEnabled,
      quietHoursStart: state.quietHoursStart,
      quietHoursEnd: state.quietHoursEnd,
      cameraResolution: state.cameraResolution,
      cameraMirror: state.cameraMirror,
      monoInput: state.monoInput,
      monoOutput: state.monoOutput,
      autoUpdate: state.autoUpdate,
      hideUpdatePopup: state.hideUpdatePopup,
      favoriteRoomIds: state.favoriteRoomIds,
      participantVolumes: state.participantVolumes,
      participantScreenVolumes: state.participantScreenVolumes,
      // feat(inroom): per-participant voice gain (>1 boost).
      participantGains: state.participantGains,
    };
    storage.write(JSON.stringify(payload));
  }

  return createStore<PrefsState>((set, get) => ({
    ...initial,
    setTheme: (v) => { set({ theme: v }); persistFromState(get()); },
    setThemeOverrides: (v) => { set({ themeOverrides: { ...v } }); persistFromState(get()); },
    setDmBanners: (v) => { set({ dmBanners: v }); persistFromState(get()); },
    setDmPreviews: (v) => { set({ dmPreviews: v }); persistFromState(get()); },
    setRoomNotifDefault: (v) => { set({ roomNotifDefault: v }); persistFromState(get()); },
    setQuietHoursEnabled: (v) => { set({ quietHoursEnabled: v }); persistFromState(get()); },
    setQuietHoursStart: (v) => { set({ quietHoursStart: v }); persistFromState(get()); },
    setQuietHoursEnd: (v) => { set({ quietHoursEnd: v }); persistFromState(get()); },
    setCameraResolution: (v) => { set({ cameraResolution: v }); persistFromState(get()); },
    setCameraMirror: (v) => { set({ cameraMirror: v }); persistFromState(get()); },
    setMonoInput: (v) => { set({ monoInput: v }); persistFromState(get()); },
    setMonoOutput: (v) => { set({ monoOutput: v }); persistFromState(get()); },
    setAutoUpdate: (v) => { set({ autoUpdate: v }); persistFromState(get()); },
    setHideUpdatePopup: (v) => { set({ hideUpdatePopup: v }); persistFromState(get()); },
    setMicDeviceId: (v) => { set({ micDeviceId: v }); persistFromState(get()); },
    setSpeakerDeviceId: (v) => { set({ speakerDeviceId: v }); persistFromState(get()); },
    setCameraDeviceId: (v) => { set({ cameraDeviceId: v }); persistFromState(get()); },
    setResolution: (v) => { set({ resolution: v }); persistFromState(get()); },
    setFrameRate: (v) => { set({ frameRate: v }); persistFromState(get()); },
    setShareAudio: (v) => { set({ shareAudio: v }); persistFromState(get()); },
    setPttKeybind: (v) => { set({ pttKeybind: v }); persistFromState(get()); },
    setMuteKeybind: (v) => { set({ muteKeybind: v }); persistFromState(get()); },
    setDeafenKeybind: (v) => { set({ deafenKeybind: v }); persistFromState(get()); },
    setShareScreenKeybind: (v) => { set({ shareScreenKeybind: v }); persistFromState(get()); },
    setOpenSettingsKeybind: (v) => { set({ openSettingsKeybind: v }); persistFromState(get()); },
    setLeaveRoomKeybind: (v) => { set({ leaveRoomKeybind: v }); persistFromState(get()); },
    setCompatibilityMode: (v) => { set({ compatibilityMode: v }); persistFromState(get()); },
    setCrashReporting: (v) => { set({ crashReporting: v }); persistFromState(get()); },
    setShowDiagnostics: (v) => { set({ showDiagnostics: v }); persistFromState(get()); },
    setJoinLeaveToasts: (v) => { set({ joinLeaveToasts: v }); persistFromState(get()); },
    setNoiseSuppression: (v) => { set({ noiseSuppression: v }); persistFromState(get()); },
    setEchoCancellation: (v) => { set({ echoCancellation: v }); persistFromState(get()); },
    setAutoGainControl: (v) => { set({ autoGainControl: v }); persistFromState(get()); },
    setMicGain: (v) => { set({ micGain: v }); persistFromState(get()); },
    setInputProfile: (v) => { set({ inputProfile: v }); persistFromState(get()); },
    setVadEnabled: (v) => { set({ vadEnabled: v }); persistFromState(get()); },
    setInputSensitivity: (v) => { set({ inputSensitivity: v }); persistFromState(get()); },
    setServerUrl: (v) => { set({ serverUrl: v }); persistFromState(get()); },
    toggleFavoriteRoom: (id) => {
      const { favoriteRoomIds } = get();
      const next = favoriteRoomIds.includes(id)
        ? favoriteRoomIds.filter((x) => x !== id)
        : [...favoriteRoomIds, id];
      set({ favoriteRoomIds: next });
      persistFromState(get());
    },
    setParticipantVolume: (id, volume) => {
      set({ participantVolumes: { ...get().participantVolumes, [id]: volume } });
      persistFromState(get());
    },
    setParticipantScreenVolume: (id, volume) => {
      set({ participantScreenVolumes: { ...get().participantScreenVolumes, [id]: volume } });
      persistFromState(get());
    },
    // feat(inroom): per-participant voice gain (>1 boost).
    setParticipantGain: (id, gain) => {
      set({ participantGains: { ...get().participantGains, [id]: gain } });
      persistFromState(get());
    },
  }));
}

export const localStorageAdapter: PrefsStorage = {
  read: () => globalThis.localStorage?.getItem("r3dvoice.prefs") ?? null,
  write: (v) => globalThis.localStorage?.setItem("r3dvoice.prefs", v),
};
