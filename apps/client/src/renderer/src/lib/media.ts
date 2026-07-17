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
    noiseSuppression: false,
    echoCancellation: false,
    autoGainControl: false,
    ...(options.mono ? { channelCount: { ideal: 1 } } : {}),
  };
  let stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });

  const policy = nsPolicy(options.noiseSuppression);
  if (policy.rnnoise) {
    try {
      const { applyRnnoise } = await import("./rnnoise-stream.js");
      stream = await applyRnnoise(stream);
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

  if (options.autoGainControl) {
    stream = applySoftwareAgc(stream);
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
  const dest = ctx.createMediaStreamDestination();
  if (options.mono) dest.channelCount = 1;
  source.connect(gainNode).connect(dest);
  // eslint-disable-next-line no-console
  console.log(
    `[mic] pipeline open — initial gain=${gainNode.gain.value.toFixed(2)} ` +
      `ctx.state=${ctx.state} sampleRate=${ctx.sampleRate}`,
  );

  return {
    stream: dest.stream,
    setGain: (g) => {
      gainNode.gain.value = g;
      // eslint-disable-next-line no-console
      console.log(`[mic] gain → ${g.toFixed(2)} (ctx.state=${ctx.state})`);
    },
    close: () => {
      try { source.disconnect(); } catch { /* */ }
      try { gainNode.disconnect(); } catch { /* */ }
      void ctx.close();
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
function applySoftwareAgc(stream: MediaStream): MediaStream {
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
  return dest.stream;
}

