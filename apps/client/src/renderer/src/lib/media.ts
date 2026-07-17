export interface DeviceInfo {
  deviceId: string;
  label: string;
}

async function enumerateByKind(
  kind: "audioinput" | "audiooutput" | "videoinput",
): Promise<DeviceInfo[]> {
  const md = globalThis.navigator?.mediaDevices;
  if (!md?.enumerateDevices) return [];
  const devices = await md.enumerateDevices();
  return devices
    .filter((d) => d.kind === kind)
    .map((d) => ({ deviceId: d.deviceId, label: d.label || "(unnamed device)" }));
}

export function listAudioInputs(): Promise<DeviceInfo[]> {
  return enumerateByKind("audioinput");
}

export function listAudioOutputs(): Promise<DeviceInfo[]> {
  return enumerateByKind("audiooutput");
}

export function listVideoInputs(): Promise<DeviceInfo[]> {
  return enumerateByKind("videoinput");
}

/**
 * Subscribe to mic level from a MediaStream track. Returns a cleanup function.
 * `onLevel` is called ~30fps with a 0..1 amplitude estimate (RMS).
 */
export function subscribeMicLevel(
  stream: MediaStream,
  onLevel: (level: number) => void,
): () => void {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  source.connect(analyser);

  const buf = new Uint8Array(analyser.fftSize);
  let rafId = 0;
  let cancelled = false;

  const tick = (): void => {
    if (cancelled) return;
    analyser.getByteTimeDomainData(buf);
    // RMS: convert 0..255 to -1..1, square, mean, sqrt
    let sum = 0;
    for (let i = 0; i < buf.length; i += 1) {
      const v = (buf[i]! - 128) / 128;
      sum += v * v;
    }
    const rms = Math.sqrt(sum / buf.length);
    onLevel(Math.min(1, rms * 6));
    rafId = requestAnimationFrame(tick);
  };
  rafId = requestAnimationFrame(tick);

  return () => {
    cancelled = true;
    cancelAnimationFrame(rafId);
    source.disconnect();
    void ctx.close();
  };
}

export interface MicProcessingOptions {
  noiseSuppression?: "off" | "low" | "high";
  echoCancellation?: boolean;
  autoGainControl?: boolean;
  /**
   * Force mono capture + downmix (task #12). Single-channel interfaces
   * (e.g. a mic wired only to the LEFT input of a stereo USB interface)
   * otherwise publish stereo with a silent right channel — listeners hear
   * you in one ear. Mono averages the channels and centers the voice.
   */
  mono?: boolean;
  /**
   * Linear input gain. 1.0 = unity. Anything other than 1 routes the mic
   * through a Web Audio GainNode pipeline; the AudioContext lives for the
   * stream's lifetime (no automatic cleanup, but small/cheap).
   */
  gain?: number;
  /**
   * Voice-activity gating (Discord's "input sensitivity"): when enabled, the
   * published signal is muted until the input level crosses `threshold`
   * (0..1 on the same scale as onLevel), so background noise between words
   * isn't transmitted. Off = open mic.
   */
  vad?: { enabled: boolean; threshold: number };
  /** Per-frame level (0..1) + whether the gate is currently open (speaking). */
  onLevel?: (level: number, speaking: boolean) => void;
}

/** Pref level → which software pipeline stages to apply. */
function nsPolicy(level: "off" | "low" | "high" | undefined): {
  rnnoise: boolean;
} {
  switch (level ?? "low") {
    case "off":
      return { rnnoise: false };
    case "low":
    case "high":
      // Both levels run the RNNoise WASM worklet — same model. The
      // distinction in the UI is mostly historical now that we don't use
      // Chromium's built-in NS at all (browser constraints are forced false
      // to avoid touching Windows audio settings). Future: add a spectral
      // gate stage after RNNoise to differentiate "high".
      return { rnnoise: true };
  }
}

/**
 * Ask for mic access and return a stream from the given device. Throws on denial.
 * Processing options map onto Chromium's WebRTC audio constraints. "high" pushes
 * NS hard but stops short of bundling RNNoise — that's a future audio worklet job.
 */
export interface MicPipeline {
  stream: MediaStream;
  /** Live-tweak the user gain. ALWAYS available — the pipeline keeps a
   *  GainNode in the chain even at unity so the slider can adjust without
   *  re-opening the mic. */
  setGain(gain: number): void;
  /** Live-update voice-activity gating without re-opening the mic. */
  setVad(enabled: boolean, threshold: number): void;
  /** Release AudioContexts. Call when the publish is done. */
  close(): void;
}

export async function openMicPipeline(
  deviceId: string | undefined,
  options: MicProcessingOptions = {},
): Promise<MicPipeline> {
  if (!globalThis.navigator?.mediaDevices?.getUserMedia) {
    throw new Error("mic unavailable");
  }
  const audioConstraints: MediaTrackConstraints = {
    ...(deviceId ? { deviceId: { exact: deviceId } } : {}),
    // Browser noise-suppression and AGC stay OFF — RNNoise (below) does NS and
    // a Web Audio compressor does AGC, so enabling the browser's would
    // double-process and smear the voice. Echo cancellation is the exception:
    // ONLY the browser's AEC can cancel far-end echo (RNNoise can't), so honor
    // the pref (default on). Previously this was hardcoded false, so echo
    // cancellation NEVER ran — anyone not wearing headphones echoed. That was
    // the #1 "sounds terrible" cause.
    noiseSuppression: false,
    echoCancellation: options.echoCancellation ?? true,
    autoGainControl: false,
    ...(options.mono ? { channelCount: { ideal: 1 } } : {}),
  };
  let stream: MediaStream;
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
  } catch (err) {
    // A stale/absent exact deviceId (common when the same account opens the
    // WEB client, whose device ids differ from the desktop app's, or after a
    // device is unplugged) makes some browsers reject WITHOUT ever prompting —
    // which looks like "it won't ask for mic permission". Retry with the
    // default device so the prompt actually appears.
    if (deviceId && (err instanceof DOMException) && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
      const { deviceId: _drop, ...rest } = audioConstraints;
      stream = await navigator.mediaDevices.getUserMedia({ audio: rest, video: false });
    } else {
      throw err;
    }
  }

  // Raw getUserMedia stream — the only node that actually owns the mic
  // hardware. The RNNoise/AGC/gain graphs below derive NEW streams from it;
  // stopping those doesn't release the device, so close() must stop this one
  // explicitly or the OS mic indicator stays lit after leaving a call.
  const rawInput = stream;

  const policy = nsPolicy(options.noiseSuppression);
  // RNNoise + AGC each spin up their own AudioContext/worklet on a derived
  // stream. Track them so close() can tear each down — otherwise every mic
  // reopen leaks a context and after ~6 Chromium refuses to open any more.
  let rnnoiseStream: MediaStream | null = null;
  let disposeRnnoiseFn: ((s: MediaStream) => Promise<void>) | null = null;
  if (policy.rnnoise) {
    try {
      const mod = await import("./rnnoise-stream.js");
      stream = await mod.applyRnnoise(stream);
      rnnoiseStream = stream;
      disposeRnnoiseFn = mod.disposeRnnoise;
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[mic] RNNoise unavailable; mic will be raw:", err);
    }
  } else {
    // eslint-disable-next-line no-console
    console.log(
      "[mic] noise suppression OFF — Settings → Mic → Noise suppression is set to 'off'",
    );
  }

  let agcStream: MediaStream | null = null;
  let agcCtx: AudioContext | null = null;
  if (options.autoGainControl) {
    const agc = applySoftwareAgc(stream);
    stream = agc.stream;
    agcStream = agc.stream;
    agcCtx = agc.ctx;
  }

  // Always wrap in a GainNode pipeline — even at unity. That way the user's
  // gain slider can update the value live without re-opening the mic.
  const ctx = new AudioContext();
  // Chromium can hand back a suspended AudioContext even when openMicPipeline
  // is invoked from inside a user-gesture handler (race with autoplay policy
  // checks during async getUserMedia). Resume explicitly so the gain chain
  // actually carries audio.
  if (ctx.state === "suspended") {
    void ctx.resume();
  }
  const source = ctx.createMediaStreamSource(stream);
  const gainNode = ctx.createGain();
  gainNode.gain.value = options.gain ?? 1;
  if (options.mono) {
    // Belt and braces with the capture constraint: force the graph itself
    // to mix down to one channel (0.5·L + 0.5·R) so a left-only signal
    // reaches listeners centered instead of half-silent stereo.
    gainNode.channelCount = 1;
    gainNode.channelCountMode = "explicit";
    gainNode.channelInterpretation = "speakers";
  }
  // Voice-activity gate: a second GainNode after the user gain that opens/closes
  // based on measured level. The AnalyserNode taps the signal post-gain so the
  // meter and threshold share one scale.
  const gateNode = ctx.createGain();
  gateNode.gain.value = 1;
  const analyser = ctx.createAnalyser();
  analyser.fftSize = 512;
  const dest = ctx.createMediaStreamDestination();
  if (options.mono) dest.channelCount = 1;
  source.connect(gainNode);
  gainNode.connect(analyser);
  gainNode.connect(gateNode).connect(dest);

  let vadEnabled = options.vad?.enabled ?? false;
  let threshold = options.vad?.threshold ?? 0;
  const buf = new Float32Array(analyser.fftSize);
  const HOLD_MS = 250; // keep the gate open this long after level dips
  let lastAbove = 0;
  let gateTarget = 1; // avoid rescheduling ramps every frame
  let raf = 0;
  const loop = (): void => {
    analyser.getFloatTimeDomainData(buf);
    let sum = 0;
    for (let i = 0; i < buf.length; i++) sum += buf[i]! * buf[i]!;
    const rms = Math.sqrt(sum / buf.length);
    const level = Math.min(1, rms * 4); // speech rms ~0.05-0.25 → readable 0..1
    let speaking = true;
    if (vadEnabled) {
      const now = performance.now();
      if (level >= threshold) lastAbove = now;
      speaking = now - lastAbove < HOLD_MS;
      const target = speaking ? 1 : 0;
      if (target !== gateTarget) {
        gateTarget = target;
        // Fast attack (no clipped word starts), gentle release (no chatter).
        gateNode.gain.setTargetAtTime(target, ctx.currentTime, target ? 0.015 : 0.08);
      }
    } else if (gateTarget !== 1) {
      gateTarget = 1;
      gateNode.gain.setTargetAtTime(1, ctx.currentTime, 0.01);
    }
    options.onLevel?.(level, speaking);
    raf = requestAnimationFrame(loop);
  };
  raf = requestAnimationFrame(loop);

  // eslint-disable-next-line no-console
  console.log(
    `[mic] pipeline open — gain=${gainNode.gain.value.toFixed(2)} ` +
      `vad=${vadEnabled ? `on@${threshold.toFixed(2)}` : "off"} ctx.state=${ctx.state}`,
  );

  return {
    stream: dest.stream,
    setGain: (g) => {
      gainNode.gain.value = g;
    },
    setVad: (enabled, t) => {
      vadEnabled = enabled;
      threshold = t;
    },
    close: () => {
      cancelAnimationFrame(raf);
      try { source.disconnect(); } catch { /* */ }
      try { gainNode.disconnect(); } catch { /* */ }
      try { gateNode.disconnect(); } catch { /* */ }
      try { analyser.disconnect(); } catch { /* */ }
      void ctx.close();
      // Tear down the derived-stage contexts the gain ctx above doesn't own.
      if (agcCtx) void agcCtx.close();
      if (rnnoiseStream && disposeRnnoiseFn) void disposeRnnoiseFn(rnnoiseStream);
      // Stop every derived + raw track so the mic hardware is actually
      // released (OS indicator off), not just disconnected from the graph.
      agcStream?.getTracks().forEach((t) => t.stop());
      rnnoiseStream?.getTracks().forEach((t) => t.stop());
      rawInput.getTracks().forEach((t) => t.stop());
    },
  };
}

/**
 * Backwards-compatible wrapper. Existing callers (PreJoin VU meter etc.)
 * just want a MediaStream — they don't need gain control.
 */
export async function openMicStream(
  deviceId: string | undefined,
  options: MicProcessingOptions = {},
): Promise<MediaStream> {
  const p = await openMicPipeline(deviceId, options);
  return p.stream;
}

/**
 * Software AGC via Web Audio's DynamicsCompressor + a fixed make-up gain.
 * Caps loud peaks (so shouting doesn't blow out the other side), with a
 * gentle 6:1 ratio that mostly leaves normal speech alone. No interaction
 * with the OS mic — purely a per-stream Web Audio graph.
 */
function applySoftwareAgc(stream: MediaStream): { stream: MediaStream; ctx: AudioContext } {
  const ctx = new AudioContext();
  const source = ctx.createMediaStreamSource(stream);
  const compressor = ctx.createDynamicsCompressor();
  compressor.threshold.value = -18;
  compressor.knee.value = 30;
  compressor.ratio.value = 6;
  compressor.attack.value = 0.005;
  compressor.release.value = 0.1;
  const makeup = ctx.createGain();
  makeup.gain.value = 1.5;
  const dest = ctx.createMediaStreamDestination();
  source.connect(compressor).connect(makeup).connect(dest);
  // Return the ctx too — the caller threads it into the pipeline's close() so
  // it's actually freed (one AudioContext leaked per reopen otherwise).
  return { stream: dest.stream, ctx };
}

