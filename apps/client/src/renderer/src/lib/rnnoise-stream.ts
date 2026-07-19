// RNNoise-based mic noise suppression. Mic stream → AudioWorklet that runs
// the @jitsi/rnnoise-wasm denoiser → MediaStreamDestination → cleaned stream.
//
// RNNoise eats 480 mono Float32 samples per call at 48 kHz, scaled to the
// int16 range (–32768..32767). Web Audio gives us 128 samples per process()
// invocation, so the worklet keeps a circular buffer to bridge the rates
// (LCM = 1920 samples).
//
// The Jitsi sync build inlines the WASM as base64, so the worklet is fully
// self-contained once the JS string is concatenated in.

// ?raw is a Vite suffix that loads the file content as a string at build
// time, so we can splice it into a worklet source.
import rnnoiseSyncSrc from "@jitsi/rnnoise-wasm/dist/rnnoise-sync.js?raw";

// Worklet processor source - concatenated with the rnnoise sync module so
// `createRNNWasmModuleSync` is in scope when the worklet starts.
const WORKLET_SUFFIX = `
class RnnoiseProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    const wasm = createRNNWasmModuleSync();
    this._wasm = wasm;
    this._state = wasm._rnnoise_create(0);
    // RNNoise needs 480-sample frames; allocate one input + one output buffer.
    this._frameSize = 480;
    this._inPtr = wasm._malloc(this._frameSize * 4);
    this._outPtr = wasm._malloc(this._frameSize * 4);
    this._inHeap = new Float32Array(wasm.HEAPF32.buffer, this._inPtr, this._frameSize);
    this._outHeap = new Float32Array(wasm.HEAPF32.buffer, this._outPtr, this._frameSize);

    // Pending samples between Web Audio's 128-sample chunks and RNNoise's 480.
    this._capacity = 1920; // LCM(128, 480)
    this._inputBuf = new Float32Array(this._capacity);
    this._inputFill = 0;
    this._outputBuf = new Float32Array(this._capacity);
    this._outputFill = 0;
  }

  _denoiseOneFrame() {
    // Copy input frame to WASM heap, scaled to int16 magnitude.
    for (let i = 0; i < this._frameSize; i++) {
      this._inHeap[i] = this._inputBuf[i] * 32768;
    }
    // Slide the rest of the input buffer down.
    this._inputBuf.copyWithin(0, this._frameSize, this._inputFill);
    this._inputFill -= this._frameSize;

    // Run the denoiser (returns a VAD probability we currently ignore).
    this._wasm._rnnoise_process_frame(this._state, this._outPtr, this._inPtr);

    // Append cleaned frame to output buffer, scaled back to [-1, 1].
    for (let i = 0; i < this._frameSize; i++) {
      this._outputBuf[this._outputFill + i] = this._outHeap[i] / 32768;
    }
    this._outputFill += this._frameSize;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    if (!input || !input[0] || !output || !output[0]) return true;
    const inCh = input[0];
    const outCh = output[0];
    const blockSize = inCh.length;

    // Append incoming chunk to input buffer.
    if (this._inputFill + blockSize > this._capacity) {
      // Should never happen - capacity is LCM. Drop oldest as a safety net.
      const drop = this._inputFill + blockSize - this._capacity;
      this._inputBuf.copyWithin(0, drop, this._inputFill);
      this._inputFill -= drop;
    }
    this._inputBuf.set(inCh, this._inputFill);
    this._inputFill += blockSize;

    // Drain into RNNoise frames as long as we have ≥480 samples.
    while (this._inputFill >= this._frameSize) {
      this._denoiseOneFrame();
    }

    // Emit the next 128 cleaned samples; if we don't have them yet
    // (worklet just started), output silence.
    if (this._outputFill >= blockSize) {
      outCh.set(this._outputBuf.subarray(0, blockSize));
      this._outputBuf.copyWithin(0, blockSize, this._outputFill);
      this._outputFill -= blockSize;
    } else {
      outCh.fill(0);
    }
    // Mirror to other output channels (mono → mono, but Web Audio may give us stereo).
    for (let c = 1; c < output.length; c++) {
      output[c]?.set(outCh);
    }
    return true;
  }
}

registerProcessor('rnnoise-processor', RnnoiseProcessor);
`;

const WORKLET_SOURCE = rnnoiseSyncSrc + "\n" + WORKLET_SUFFIX;

interface ActiveRnnoise {
  ctx: AudioContext;
  source: MediaStreamAudioSourceNode;
  worklet: AudioWorkletNode;
  destination: MediaStreamAudioDestinationNode;
}

const activeStreams = new WeakMap<MediaStream, ActiveRnnoise>();

/**
 * Wrap a mic MediaStream in an RNNoise pipeline and return a new stream.
 * The original stream's track keeps running underneath; stop the new
 * stream's track AND the original to release everything.
 */
export async function applyRnnoise(input: MediaStream): Promise<MediaStream> {
  // RNNoise was trained at 48 kHz; let the AudioContext run there too.
  const ctx = new AudioContext({ sampleRate: 48000, latencyHint: "interactive" });

  const blob = new Blob([WORKLET_SOURCE], { type: "application/javascript" });
  const url = URL.createObjectURL(blob);
  try {
    await ctx.audioWorklet.addModule(url);
  } finally {
    URL.revokeObjectURL(url);
  }

  const source = ctx.createMediaStreamSource(input);
  const worklet = new AudioWorkletNode(ctx, "rnnoise-processor", {
    numberOfInputs: 1,
    numberOfOutputs: 1,
    channelCount: 1,
    channelCountMode: "explicit",
    outputChannelCount: [1],
  });
  const destination = ctx.createMediaStreamDestination();
  source.connect(worklet).connect(destination);

  // eslint-disable-next-line no-console
  console.log("[mic] RNNoise WASM worklet active - denoiser is in the publish chain");

  const out = destination.stream;
  activeStreams.set(out, { ctx, source, worklet, destination });
  return out;
}

/**
 * Tear down the RNNoise pipeline associated with a stream returned by
 * applyRnnoise. Safe to call on any stream - no-op if not RNNoise-managed.
 */
export async function disposeRnnoise(stream: MediaStream): Promise<void> {
  const a = activeStreams.get(stream);
  if (!a) return;
  activeStreams.delete(stream);
  try { a.source.disconnect(); } catch { /* */ }
  try { a.worklet.disconnect(); } catch { /* */ }
  try { await a.ctx.close(); } catch { /* */ }
}
