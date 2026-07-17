import type { PrefsState } from "./prefs-store.js";

export interface ScreenQuality {
  width: number;
  height: number;
  frameRate: number;
  /**
   * Audio source for the screenshare:
   *   null  → no audio (silent share)
   *   "all" → every app's audio except RedVoice's own playback
   *   "<pid>" → only this process's audio (per-app capture)
   */
  audioSource: null | "all" | string;
}

export interface JoinSelection {
  micDeviceId: string | null;
  speakerDeviceId: string | null;
  publishScreen: boolean;
  screenQuality: ScreenQuality;
  /** Deck rule: joins start muted — no pre-join screen (4.5 removed). */
  startMuted: boolean;
}

export const RESOLUTIONS: Record<string, { width: number; height: number }> = {
  "720p": { width: 1280, height: 720 },
  "1080p": { width: 1920, height: 1080 },
  "1440p": { width: 2560, height: 1440 },
  "4K": { width: 3840, height: 2160 },
};

// Joins are muted-by-default and use the persisted device/quality prefs
// (Settings › Devices replaces the old pre-join screen as the place to
// change them).
export function buildJoinSelection(
  prefs: Pick<PrefsState, "micDeviceId" | "speakerDeviceId" | "resolution" | "frameRate">,
): JoinSelection {
  const res = RESOLUTIONS[prefs.resolution] ?? RESOLUTIONS["1080p"]!;
  return {
    micDeviceId: prefs.micDeviceId,
    speakerDeviceId: prefs.speakerDeviceId,
    publishScreen: false,
    screenQuality: {
      width: res.width,
      height: res.height,
      frameRate: prefs.frameRate,
      audioSource: null,
    },
    startMuted: true,
  };
}
