import { createStore, type StoreApi } from "zustand/vanilla";

export interface PrefsStorage {
  read(): string | null;
  write(value: string): void;
}

export type Resolution = "720p" | "1080p" | "1440p" | "4K";
export type FrameRate = 30 | 60;
export type NoiseSuppressionLevel = "off" | "low" | "high";

export type ThemePreset = "light" | "dark" | "system";

export interface PrefsState {
  theme: ThemePreset;
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
  noiseSuppression: NoiseSuppressionLevel;
  echoCancellation: boolean;
  autoGainControl: boolean;
  micGain: number;
  serverUrl: string;
  /** Room IDs the user has starred — surfaced by future Lobby UX. */
  favoriteRoomIds: string[];
  /** Per-participant voice volume map (1.0 = unity). Persists across sessions. */
  participantVolumes: Record<string, number>;
  /** Per-participant screen-audio volume map (1.0 = unity). Persists across sessions. */
  participantScreenVolumes: Record<string, number>;

  setTheme(theme: ThemePreset): void;
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
  setNoiseSuppression(v: NoiseSuppressionLevel): void;
  setEchoCancellation(v: boolean): void;
  setAutoGainControl(v: boolean): void;
  setMicGain(v: number): void;
  setServerUrl(u: string): void;
  toggleFavoriteRoom(id: string): void;
  setParticipantVolume(id: string, volume: number): void;
  setParticipantScreenVolume(id: string, volume: number): void;
}

const DEFAULTS = {
  theme: "light" as ThemePreset,
  micDeviceId: null as string | null,
  speakerDeviceId: null as string | null,
  cameraDeviceId: null as string | null,
  resolution: "1080p" as Resolution,
  frameRate: 30 as FrameRate,
  shareAudio: true,
  pttKeybind: null as string | null,
  muteKeybind: null as string | null,
  deafenKeybind: null as string | null,
  shareScreenKeybind: null as string | null,
  openSettingsKeybind: null as string | null,
  leaveRoomKeybind: null as string | null,
  compatibilityMode: false,
  crashReporting: false,
  noiseSuppression: "low" as NoiseSuppressionLevel,
  echoCancellation: true,
  // OFF by default — even our software AGC adds Web Audio chain depth
  // and was correlated with high-RTT/dialup-quality reports. Users who
  // come through quiet can boost via the live mic gain slider in Settings
  // (now applies in real time without re-opening the mic).
  autoGainControl: false,
  micGain: 1.0,
  // Server URL default, in priority order:
  //   1. VITE_SERVER_URL at build time (dev/self-host override, fresh profiles)
  //   2. web build (no Electron preload bridge at module-eval time): the page's
  //      own origin — the server serving the SPA IS the API server
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

function load(storage: PrefsStorage): typeof DEFAULTS {
  const raw = storage.read();
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const merged = { ...DEFAULTS, ...parsed };
    merged.participantVolumes = clampVolumeMap(parsed.participantVolumes);
    merged.participantScreenVolumes = clampVolumeMap(parsed.participantScreenVolumes);
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
      noiseSuppression: state.noiseSuppression,
      echoCancellation: state.echoCancellation,
      autoGainControl: state.autoGainControl,
      micGain: state.micGain,
      serverUrl: state.serverUrl,
      theme: state.theme,
      favoriteRoomIds: state.favoriteRoomIds,
      participantVolumes: state.participantVolumes,
      participantScreenVolumes: state.participantScreenVolumes,
    };
    storage.write(JSON.stringify(payload));
  }

  return createStore<PrefsState>((set, get) => ({
    ...initial,
    setTheme: (v) => { set({ theme: v }); persistFromState(get()); },
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
    setNoiseSuppression: (v) => { set({ noiseSuppression: v }); persistFromState(get()); },
    setEchoCancellation: (v) => { set({ echoCancellation: v }); persistFromState(get()); },
    setAutoGainControl: (v) => { set({ autoGainControl: v }); persistFromState(get()); },
    setMicGain: (v) => { set({ micGain: v }); persistFromState(get()); },
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
  }));
}

export const localStorageAdapter: PrefsStorage = {
  read: () => globalThis.localStorage?.getItem("r3dvoice.prefs") ?? null,
  write: (v) => globalThis.localStorage?.setItem("r3dvoice.prefs", v),
};
