/**
 * Mono OUTPUT routing (task #12): downmix all received audio so both ears
 * hear the same signal — for single-ear headsets and asymmetric hearing.
 *
 * Mechanism: each <audio> element is routed through Web Audio
 * (MediaElementAudioSourceNode → GainNode → destination). The gain node's
 * channel config is the mono/stereo switch. createMediaElementSource is
 * irreversible per element, so once an element has EVER been routed it
 * stays in the graph; disabling mono just flips the node back to
 * pass-through stereo. Elements are only routed at all after the first
 * enable, so users who never touch the toggle keep the native path.
 */

let ctx: AudioContext | null = null;
let mixNode: GainNode | null = null;
let monoOn = false;
const routed = new WeakSet<HTMLAudioElement>();

function ensureGraph(): void {
  if (ctx) return;
  ctx = new AudioContext();
  mixNode = ctx.createGain();
  mixNode.gain.value = 1;
  mixNode.connect(ctx.destination);
}

function applyChannelMode(): void {
  if (!mixNode) return;
  if (monoOn) {
    mixNode.channelCount = 1;
    mixNode.channelCountMode = "explicit";
    mixNode.channelInterpretation = "speakers";
  } else {
    mixNode.channelCountMode = "max";
    mixNode.channelInterpretation = "speakers";
  }
}

/** Route one element through the graph (idempotent). */
export function routeElement(el: HTMLAudioElement): void {
  if (!monoOn && !routed.has(el)) return; // never routed + mono off → native path
  ensureGraph();
  if (routed.has(el) || !ctx || !mixNode) return;
  try {
    const src = ctx.createMediaElementSource(el);
    src.connect(mixNode);
    routed.add(el);
  } catch {
    // Element already captured by another context — leave it native.
  }
}

/** Enable/disable mono output. Routes all current audio elements under `root`. */
export function setMonoOutput(on: boolean, root?: HTMLElement | null): void {
  monoOn = on;
  if (on) {
    ensureGraph();
    if (ctx?.state === "suspended") void ctx.resume();
    root?.querySelectorAll("audio").forEach((el) => routeElement(el as HTMLAudioElement));
  }
  applyChannelMode();
}

/** Keep Web Audio playback on the selected output device. */
export async function setMonoOutputSink(deviceId: string | null): Promise<void> {
  if (!ctx) return;
  const c = ctx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof c.setSinkId === "function") {
    try {
      await c.setSinkId(deviceId ?? "");
    } catch {
      /* unsupported sink — default output */
    }
  }
}
