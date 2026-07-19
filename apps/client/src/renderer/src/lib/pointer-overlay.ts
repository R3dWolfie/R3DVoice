// Collaborative pointer overlay - the web-realistic version of "remote
// control" of a screenshare. A viewer's cursor position (normalized to the
// shared video) is broadcast over the LiveKit data channel; everyone watching
// that share sees a labeled cursor where the viewer is pointing. No actual
// input injection (a web page can't drive another OS) - a shared laser pointer.

export interface RemotePointer {
  /** Sender identity (who is pointing). */
  id: string;
  /** Identity of the participant whose screen this points at. */
  share: string;
  /** Normalized position within the shared video content, 0..1. */
  x: number;
  y: number;
  name: string;
  /** performance.now() of the last update - used for expiry. */
  ts: number;
}

const POINTERS = new Map<string, RemotePointer>();
const STALE_MS = 2500;

function now(): number {
  return typeof performance !== "undefined" ? performance.now() : 0;
}

export function setRemotePointer(p: Omit<RemotePointer, "ts">): void {
  POINTERS.set(p.id, { ...p, ts: now() });
}

export function clearRemotePointer(id: string): void {
  POINTERS.delete(id);
}

/** Active (non-stale) pointers aimed at a given sharer's screen. */
export function getPointersForShare(share: string): RemotePointer[] {
  const t = now();
  const out: RemotePointer[] = [];
  for (const [id, p] of POINTERS) {
    if (t - p.ts > STALE_MS) {
      POINTERS.delete(id);
      continue;
    }
    if (p.share === share) out.push(p);
  }
  return out;
}

const PALETTE = ["#e07a5f", "#3d5a80", "#81b29a", "#c98410", "#8a6cd1", "#d96c75", "#5b8bd6", "#5fa667"];
export function pointerColor(id: string): string {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return PALETTE[Math.abs(h) % PALETTE.length]!;
}

/**
 * The rectangle the actual video content occupies inside a letterboxed
 * (object-fit: contain) <video> - used to map pointer coords onto the real
 * picture, not the black bars. Coordinates are relative to the element's box.
 */
export function videoContentRect(v: HTMLVideoElement): { x: number; y: number; w: number; h: number } {
  const ew = v.clientWidth;
  const eh = v.clientHeight;
  const iw = v.videoWidth || ew;
  const ih = v.videoHeight || eh;
  if (!iw || !ih || !ew || !eh) return { x: 0, y: 0, w: ew, h: eh };
  const scale = Math.min(ew / iw, eh / ih);
  const w = iw * scale;
  const h = ih * scale;
  return { x: (ew - w) / 2, y: (eh - h) / 2, w, h };
}
