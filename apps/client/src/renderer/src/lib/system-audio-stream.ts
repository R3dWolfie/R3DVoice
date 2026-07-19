// Builds a MediaStream from raw PCM frames produced by the native
// system-audio-capture helper (Windows). Used as the *audio* source for
// screenshare publishing so the captured mix excludes R3DVoice's own
// playback (incoming voices) - preventing the "I hear myself through your
// screenshare" loop.
//
// On non-Windows or when the helper isn't bundled / OS doesn't support
// PROCESS_LOOPBACK_MODE, returns null and the caller falls back to
// browser-default getDisplayMedia({audio:true}).
//
// Wire format (must match LoopbackCapture.cpp's m_CaptureFormat):
//   signed 16-bit LE PCM, 48000 Hz, 2 channels, interleaved.

// AudioWorklet processor source. Lives as a string because it runs in the
// AudioWorkletGlobalScope, which can't `import` from the rest of the bundle.
// The host posts ArrayBuffers of int16 PCM frames; the processor de-interleaves
// to two float channels and feeds a ring buffer that `process()` drains.
const PROCESSOR_SOURCE = `
class SystemAudioPcmProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // Ring buffer holds float32 samples, interleaved, before splitting into
    // two channel arrays at process() time. Sized for ~500 ms of audio at
    // 48 kHz stereo (48000 * 2 * 0.5 = 48000 samples). Bigger than typical
    // jitter, smaller than memory pressure.
    this._capacity = 48000;
    this._buf = new Float32Array(this._capacity);
    this._read = 0;
    this._write = 0;
    this._fill = 0;

    this.port.onmessage = (e) => {
      const data = e.data;
      if (!(data instanceof ArrayBuffer)) return;
      const i16 = new Int16Array(data);
      const n = i16.length;
      // Drop oldest if we'd overflow - keeps latency bounded if the host
      // ever bursts ahead of us.
      if (this._fill + n > this._capacity) {
        const drop = this._fill + n - this._capacity;
        this._read = (this._read + drop) % this._capacity;
        this._fill -= drop;
      }
      for (let i = 0; i < n; i++) {
        this._buf[this._write] = i16[i] / 32768;
        this._write = (this._write + 1) % this._capacity;
      }
      this._fill += n;
    };
  }

  process(_inputs, outputs) {
    const out = outputs[0];
    const left = out[0];
    const right = out[1] || left;
    const frames = left.length;
    const need = frames * 2;
    if (this._fill < need) {
      // Underrun: emit silence. Don't disconnect - the WebRTC sender wants
      // a continuous stream, and silence frames keep the timestamp moving.
      left.fill(0);
      if (right !== left) right.fill(0);
      return true;
    }
    for (let i = 0; i < frames; i++) {
      left[i] = this._buf[this._read];
      this._read = (this._read + 1) % this._capacity;
      const r = this._buf[this._read];
      this._read = (this._read + 1) % this._capacity;
      if (right !== left) right[i] = r;
    }
    this._fill -= need;
    return true;
  }
}

registerProcessor('system-audio-pcm-processor', SystemAudioPcmProcessor);
`;

interface ActiveStream {
  ctx: AudioContext;
  destination: MediaStreamAudioDestinationNode;
  worklet: AudioWorkletNode;
  unsubscribeChunk: () => void;
  unsubscribeEnded: () => void;
}

let active: ActiveStream | null = null;

/**
 * Starts the native helper and wires its PCM output into a MediaStream.
 * Returns the MediaStream on success, or null if unavailable.
 *
 * Pass `includePid` to capture only one process (per-app share). Without it,
 * the helper captures system mix excluding R3DVoice.
 */
export async function startSystemAudioStream(
  options: { includePid?: number } = {},
): Promise<MediaStream | null> {
  if (active) {
    return active.destination.stream;
  }

  if (typeof window === "undefined" || !window.r3dvoice?.startSystemAudioCapture) {
    return null;
  }

  const result = await window.r3dvoice.startSystemAudioCapture(options);
  if (result !== "started") return null;

  // Past this point the native OS loopback is already running. Anything that
  // throws here (format probe, AudioContext, worklet) would leave `active`
  // null, so a later stopSystemAudioStream() early-returns and the capture
  // runs for the whole process lifetime. Tear it down on any failure.
  let ctx: AudioContext | null = null;
  try {
    const fmt = await window.r3dvoice.systemAudioFormat();
    // Match the helper's sample rate - otherwise the AudioContext would
    // resample, which adds latency and CPU.
    ctx = new AudioContext({ sampleRate: fmt.sampleRate, latencyHint: "interactive" });

    const blob = new Blob([PROCESSOR_SOURCE], { type: "application/javascript" });
    const url = URL.createObjectURL(blob);
    try {
      await ctx.audioWorklet.addModule(url);
    } finally {
      URL.revokeObjectURL(url);
    }

    const worklet = new AudioWorkletNode(ctx, "system-audio-pcm-processor", {
      numberOfInputs: 0,
      numberOfOutputs: 1,
      outputChannelCount: [fmt.channels],
    });

    const destination = ctx.createMediaStreamDestination();
    worklet.connect(destination);

    // Forward PCM chunks from main → worklet. We pass the ArrayBuffer (zero-
    // copy transfer would need .postMessage(ab, [ab]) but the IPC layer
    // already structured-cloned it once, so a second copy is unavoidable).
    const unsubscribeChunk = window.r3dvoice.onSystemAudioChunk((chunk) => {
      // chunk is a Uint8Array view from IPC; hand the underlying buffer to
      // the worklet so it can read it as Int16Array.
      worklet.port.postMessage(chunk.buffer.slice(chunk.byteOffset, chunk.byteOffset + chunk.byteLength));
    });

    const unsubscribeEnded = window.r3dvoice.onSystemAudioEnded(() => {
      void stopSystemAudioStream();
    });

    active = { ctx, destination, worklet, unsubscribeChunk, unsubscribeEnded };
    return destination.stream;
  } catch (err) {
    try { await window.r3dvoice.stopSystemAudioCapture(); } catch { /* */ }
    if (ctx) { try { await ctx.close(); } catch { /* */ } }
    // eslint-disable-next-line no-console
    console.warn("[system-audio] setup failed after capture started; torn down:", err);
    return null;
  }
}

export async function stopSystemAudioStream(): Promise<void> {
  if (!active) return;
  const a = active;
  active = null;
  a.unsubscribeChunk();
  a.unsubscribeEnded();
  try { a.worklet.disconnect(); } catch { /* */ }
  try { await a.ctx.close(); } catch { /* */ }
  try { await window.r3dvoice.stopSystemAudioCapture(); } catch { /* */ }
}
