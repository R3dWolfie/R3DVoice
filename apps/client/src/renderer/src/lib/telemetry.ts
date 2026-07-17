// Dependency-free real-user UX telemetry. Turns "it feels laggy / buttons are
// unresponsive" into numbers:
//   - inp:      Interaction-to-Next-Paint — how long after a click the UI
//               actually updates. The single best proxy for "buttons feel dead".
//   - longTasks/blocking: main-thread blocks (>50ms) that freeze clicks + scroll.
//   - fps:      sustained frame rate (jank).
// All via PerformanceObserver (near-zero overhead). Call startTelemetry() once.

export interface UxMetrics {
  fps: number;
  /** Worst interaction latency (ms) in the recent window — the "p-ish" INP. */
  inpMs: number;
  /** Most recent interaction latency (ms). */
  inpRecentMs: number;
  /** Long-task count over the last 60s. */
  longTasksPerMin: number;
  /** Total main-thread blocking time (ms) in the last 1s. */
  blockingMsPerSec: number;
  /** Whether the browser supports the observers (Firefox lacks longtask). */
  supported: boolean;
}

let started = false;
let supported = false;
let frames = 0;
let lastFpsTs = 0;
let fps = 0;

const interactions: number[] = [];
let inpRecent = 0;
let longTaskTimes: number[] = [];
let blockingWindow: { t: number; ms: number }[] = [];

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

export function startTelemetry(): void {
  if (started || typeof PerformanceObserver === "undefined" || typeof requestAnimationFrame === "undefined") return;
  started = true;

  // Interaction latency (INP proxy): "event" entries carry the full
  // input→paint duration. durationThreshold keeps trivial events out.
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as PerformanceEntry[]) {
        const d = e.duration;
        if (d > 0) {
          inpRecent = d;
          interactions.push(d);
          if (interactions.length > 200) interactions.shift();
        }
      }
    }).observe({ type: "event", durationThreshold: 16, buffered: true } as PerformanceObserverInit);
    supported = true;
  } catch {
    /* event timing unsupported */
  }
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) {
        inpRecent = e.duration;
        interactions.push(e.duration);
      }
    }).observe({ type: "first-input", buffered: true } as PerformanceObserverInit);
  } catch {
    /* first-input unsupported */
  }

  // Long tasks — main-thread blocks. Chromium-only (Firefox has no longtask).
  try {
    new PerformanceObserver((list) => {
      const t = now();
      for (const e of list.getEntries()) {
        longTaskTimes.push(t);
        blockingWindow.push({ t, ms: e.duration });
      }
    }).observe({ type: "longtask", buffered: true } as PerformanceObserverInit);
    supported = true;
  } catch {
    /* longtask unsupported */
  }

  // FPS via rAF frame counting.
  const loop = (ts: number): void => {
    frames++;
    if (lastFpsTs === 0) lastFpsTs = ts;
    else if (ts - lastFpsTs >= 1000) {
      fps = Math.round((frames * 1000) / (ts - lastFpsTs));
      frames = 0;
      lastFpsTs = ts;
    }
    requestAnimationFrame(loop);
  };
  requestAnimationFrame(loop);
}

export function readUxMetrics(): UxMetrics {
  const t = now();
  longTaskTimes = longTaskTimes.filter((x) => t - x < 60_000);
  blockingWindow = blockingWindow.filter((b) => t - b.t < 1000);
  const recent = interactions.slice(-50);
  const inpMax = recent.length ? Math.max(...recent) : 0;
  const blockingMsPerSec = blockingWindow.reduce((a, b) => a + b.ms, 0);
  return {
    fps,
    inpMs: Math.round(inpMax),
    inpRecentMs: Math.round(inpRecent),
    longTasksPerMin: longTaskTimes.length,
    blockingMsPerSec: Math.round(blockingMsPerSec),
    supported,
  };
}

// ── In-call media quality (fed by InRoomScreen from LiveKit getStats) ───────
export interface CallStats {
  rttMs: number | null;
  packetLossPct: number | null;
  /** Inbound video decode fps (screenshare/camera you're receiving). */
  videoFps: number | null;
  videoRes: string | null;
  /** Cumulative freeze count on received video — the "screenshare is laggy" number. */
  freezes: number | null;
  bitrateKbps: number | null;
}

let callStats: CallStats | null = null;
export function setCallStats(s: CallStats | null): void {
  callStats = s;
}
export function readCallStats(): CallStats | null {
  return callStats;
}
