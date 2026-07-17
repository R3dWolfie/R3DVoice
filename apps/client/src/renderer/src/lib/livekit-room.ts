import {
  Room,
  RoomEvent,
  DataPacket_Kind,
  AudioPresets,
  DisconnectReason,
  ExternalE2EEKeyProvider,
  type RemoteParticipant,
  type LocalParticipant,
  Track,
  type RemoteTrack,
  type RemoteTrackPublication,
} from "livekit-client";
// Vite ?worker suffix produces a Worker constructor that's bundled separately.
// The E2EE worker is where SFrame encryption/decryption runs off the main thread.
import E2eeWorker from "livekit-client/e2ee-worker?worker";
import { startSystemAudioStream, stopSystemAudioStream } from "./system-audio-stream.js";
import { notifyJoinLeave } from "../components/notify-join-leave.js";
import { setRemotePointer, clearRemotePointer } from "./pointer-overlay.js";

export type DisconnectKind =
  | "removed-by-owner"
  | "room-deleted"
  | "server-shutdown"
  | "duplicate-identity"
  | "other";

export interface RoomStateSnapshot {
  connected: boolean;
  /**
   * True while the LiveKit SDK is trying to re-establish a dropped connection
   * (RoomEvent.Reconnecting fired, Reconnected/Connected/Disconnected not yet).
   * `connected` stays true through a blip, so this is the only signal the UI
   * has that audio has silently cut and is being recovered.
   */
  reconnecting: boolean;
  local: LocalParticipant | null;
  remotes: RemoteParticipant[];
  error: string | null;
  /** True iff the local participant is publishing a screen_share_audio track. */
  screenShareAudioEnabled: boolean;
  /** Set when the SFU disconnected us with a meaningful reason (removed/deleted). */
  disconnectKind: DisconnectKind | null;
  /** True iff E2EE is currently active (room key has been set on the provider). */
  e2eeEnabled: boolean;
  /**
   * Per-participant RTT in milliseconds (latest value the peer has broadcast).
   * Identity → ms. Local participant entry tracks our own RTT for symmetry.
   */
  rttByParticipant: Record<string, number>;
}

export type RoomStateListener = (state: RoomStateSnapshot) => void;

export interface ScreenShareQuality {
  /** Video resolution width (e.g. 1280, 1920). */
  width: number;
  /** Video resolution height (e.g. 720, 1080). */
  height: number;
  /** Frames per second (30 or 60). */
  frameRate: number;
  /**
   * Audio source to share alongside video:
   *   null  → silent share
   *   "all" → every app's audio except R3DVoice's own
   *   "<pid>" → only this process's audio
   */
  audioSource: null | "all" | string;
}

export interface JoinOptions {
  wsUrl: string;
  token: string;
  /** Optional pre-opened MediaStream to publish as mic track. */
  micStream?: MediaStream;
  /** If false (default), do not publish mic audio at all. Set true to publish. */
  publishAudio?: boolean;
  /** If true, ask LiveKit to also acquire a screenshare track on connect. */
  publishScreen?: boolean;
  /** Quality settings for the screenshare publish. Used when publishScreen is true. */
  screenQuality?: ScreenShareQuality;
}

function mapDisconnectReason(reason: DisconnectReason | undefined): DisconnectKind | null {
  switch (reason) {
    case DisconnectReason.PARTICIPANT_REMOVED:
      return "removed-by-owner";
    case DisconnectReason.ROOM_DELETED:
      return "room-deleted";
    case DisconnectReason.SERVER_SHUTDOWN:
      return "server-shutdown";
    case DisconnectReason.DUPLICATE_IDENTITY:
      return "duplicate-identity";
    case DisconnectReason.CLIENT_INITIATED:
    case undefined:
      // User-initiated leave isn't an "interesting" disconnect; surface as null.
      return null;
    default:
      return "other";
  }
}

/**
 * Max bitrate for screenshare publish. Sized for *gaming* content at native
 * framerate — receivers see 0.5 fps blocky garbage when the cap is too low,
 * because the encoder either skips frames or quantises into a brick wall.
 *
 * Reference points (industry):
 *   Discord 1080p60 ≈ 5–8 Mbps H.264
 *   Google Meet     ≈ 3–4 Mbps VP9 (presentations, low-motion)
 *   Twitch ingest   ≈ 6 Mbps  H.264 1080p60
 *
 * WebRTC's bandwidth estimator (BWE) will throttle the encoder below this
 * cap on slow links — a generous cap is safe for users with broadband, and
 * never pushes more than the link can carry.
 */
function computeScreenShareBitrate(width: number, height: number, fps: number): number {
  const pixels = width * height;
  let base: number;
  if (pixels >= 3840 * 2160) base = 12_000_000; // 4K
  else if (pixels >= 2560 * 1440) base = 7_000_000; // 1440p
  else if (pixels >= 1920 * 1080) base = 4_000_000; // 1080p
  else base = 1_500_000; // 720p and below
  // 60 fps adds ~50% to motion-area cost.
  const fpsScale = fps > 30 ? 1.5 : 1;
  return Math.round(base * fpsScale);
}

/**
 * Walk an RTCStatsReport and log the active ICE candidate pair. Tells us
 * whether the media transport is host/srflx/relay and udp/tcp — the single
 * most useful piece of info for diagnosing remote-screenshare collapse:
 *   - relay/tcp     → media is going through TURN-TCP, head-of-line blocked
 *   - relay/udp     → TURN/UDP, fine but adds a hop
 *   - srflx/udp     → STUN-discovered direct, ideal
 *   - host/udp      → LAN, ideal
 */
async function logIceCandidatePair(
  source: string,
  getReport: () => Promise<RTCStatsReport | null | undefined>,
): Promise<void> {
  try {
    const report = await getReport();
    if (!report) return;
    const pairs: Record<string, unknown>[] = [];
    const cands: Record<string, Record<string, unknown>> = {};
    const transports: Record<string, unknown>[] = [];
    report.forEach((s: { type: string; id?: string; [k: string]: unknown }) => {
      if (s.type === "candidate-pair") pairs.push(s);
      else if (s.type === "local-candidate" || s.type === "remote-candidate") {
        if (s.id) cands[s.id] = s;
      } else if (s.type === "transport") transports.push(s);
    });
    let active = pairs.find((p) => p["nominated"] === true && p["state"] === "succeeded");
    if (!active) {
      const sel = transports[0]?.["selectedCandidatePairId"] as string | undefined;
      if (sel) active = pairs.find((p) => p["id"] === sel);
    }
    if (!active) active = pairs.find((p) => p["state"] === "succeeded");
    if (!active) return;
    const localId = active["localCandidateId"] as string | undefined;
    const remoteId = active["remoteCandidateId"] as string | undefined;
    const local = localId ? cands[localId] : undefined;
    const remote = remoteId ? cands[remoteId] : undefined;
    const rttMs = active["currentRoundTripTime"] as number | undefined;
    const bweOut = active["availableOutgoingBitrate"] as number | undefined;
    const bweIn = active["availableIncomingBitrate"] as number | undefined;
    // eslint-disable-next-line no-console
    console.log(
      `[ice:${source}] local=${local?.["candidateType"] ?? "?"}/${local?.["protocol"] ?? "?"} ` +
        `remote=${remote?.["candidateType"] ?? "?"}/${remote?.["protocol"] ?? "?"} ` +
        `relayProto=${local?.["relayProtocol"] ?? "-"} ` +
        `rtt=${rttMs != null ? (rttMs * 1000).toFixed(0) + "ms" : "?"} ` +
        `bweOut=${bweOut != null ? (bweOut / 1000).toFixed(0) + "kbps" : "?"} ` +
        `bweIn=${bweIn != null ? (bweIn / 1000).toFixed(0) + "kbps" : "?"}`,
    );
  } catch {
    /* logging only */
  }
}

/**
 * Linux: capture screenshare audio. Two paths:
 *
 * 1. If `preferLabelContains` matches a virtual venmic device (e.g.
 *    "vencord-screen-share") — capture that. Excludes R3DVoice's own playback.
 * 2. Otherwise fall back to a PulseAudio/PipeWire "Monitor of …" source
 *    (full system mix; will echo unless user wears headphones).
 */
async function captureLinuxMonitorSource(
  preferLabelContains?: string,
): Promise<MediaStream | null> {
  try {
    let devices = await navigator.mediaDevices.enumerateDevices();
    if (devices.every((d) => d.label === "")) {
      try {
        const probe = await navigator.mediaDevices.getUserMedia({ audio: true });
        probe.getTracks().forEach((t) => t.stop());
      } catch { return null; }
      devices = await navigator.mediaDevices.enumerateDevices();
    }

    let target: MediaDeviceInfo | undefined;
    if (preferLabelContains) {
      const needle = preferLabelContains.toLowerCase();
      target = devices.find(
        (d) => d.kind === "audioinput" && d.label.toLowerCase().includes(needle),
      );
    }
    if (!target) {
      // Fallback: any monitor source.
      const monitors = devices.filter(
        (d) => d.kind === "audioinput" && /monitor/i.test(d.label),
      );
      if (monitors.length === 0) return null;
      target = monitors.find((m) => /default/i.test(m.label)) ?? monitors[0]!;
    }

    return await navigator.mediaDevices.getUserMedia({
      audio: {
        deviceId: { exact: target.deviceId },
        // venmic's virtual device delivers raw PCM at 48 kHz stereo. Disable
        // browser audio processing so we don't double-process.
        autoGainControl: false,
        echoCancellation: false,
        noiseSuppression: false,
        channelCount: 2,
        sampleRate: 48000,
      },
    });
  } catch {
    return null;
  }
}

// Microphone publish options, shared by both publish paths (processed-track
// and setMicrophoneEnabled). red = redundant Opus encoding — every packet also
// carries the prior frame, so a single lost packet no longer drops audio (the
// biggest win on lossy home links). dtx skips silent frames (bandwidth-only,
// fine for voice). 64 kbps mono Opus sits clearly above the LiveKit "speech"
// default (~24-32 kbps) that made voice sound thin, and above Discord's ~64k.
const MIC_PUBLISH_OPTIONS = {
  source: Track.Source.Microphone,
  red: true,
  dtx: true,
  audioPreset: { maxBitrate: 64_000 },
} as const;

export class LiveKitRoom {
  readonly room: Room;
  private listeners = new Set<RoomStateListener>();
  private connected = false;
  private reconnecting = false;
  private err: string | null = null;
  private disconnectKind: DisconnectKind | null = null;
  private keyProvider: ExternalE2EEKeyProvider | null;
  private e2eeEnabled = false;
  /** Latest RTT (ms) per participant identity. Updated via DataChannel pings. */
  private rttByParticipant: Record<string, number> = {};
  private rttBroadcastTimer: ReturnType<typeof setInterval> | null = null;
  // Cached snapshot — useSyncExternalStore compares by reference, so this must
  // stay stable between LiveKit events or React will loop forever.
  private cachedSnapshot: RoomStateSnapshot;
  // Auxiliary MediaStream backing a non-LiveKit-managed screen audio track
  // (Linux PipeWire monitor or Windows getDisplayMedia fallback). We keep the
  // stream so we can stop() its tracks when the user disables audio share.
  private screenAudioAuxStream: MediaStream | null = null;

  constructor(options: { enableE2EE?: boolean } = {}) {
    // E2EE is opt-in. When OFF, we don't construct the keyProvider/worker
    // at all — that's measured to add observable audio quality overhead in
    // some livekit-client builds even when no key is set. When ON, the
    // worker runs SFrame on every frame and key distribution kicks in via
    // RoomE2EE.
    //
    // Toggling at runtime requires a rejoin (LiveKit's e2ee config is
    // construction-time only).
    this.keyProvider = options.enableE2EE ? new ExternalE2EEKeyProvider() : null;
    // dynacast disabled — it changes simulcast layer counts at runtime and
    // has been the source of "BUNDLE codec collision PT=111" failures with
    // some server versions. adaptiveStream is fine (purely receive-side).
    const roomOpts = {
      adaptiveStream: true,
      dynacast: false,
      publishDefaults: {
        screenShareEncoding: {
          maxBitrate: 4_000_000,
          maxFramerate: 60,
        },
        // VP9 over H.264: on Linux/Windows Chromium without a VAAPI/MediaFoundation
        // hardware encoder enabled, "h264" falls back to OpenH264 (Cisco's
        // *software* encoder), which can't sustain 1080p60 on a typical
        // friend's laptop CPU → publisher encoder framerate craters to ~1 fps
        // and every receiver sees that 1 fps. The diagnostics confirmed this:
        // impl=OpenH264 for both camera and screen share. VP9's software
        // encoder (libvpx) is faster, codes flat screen content far better
        // than H.264, and has hardware decode on every modern receiver.
        videoCodec: "vp9" as const,
      },
      ...(options.enableE2EE && this.keyProvider
        ? {
            e2ee: {
              keyProvider: this.keyProvider,
              worker: new E2eeWorker(),
            },
          }
        : {}),
    };
    this.room = new Room(roomOpts);
    this.cachedSnapshot = this.computeSnapshot();

    this.room.on(RoomEvent.Connected, () => {
      this.connected = true;
      this.reconnecting = false;
      this.err = null;
      // Start broadcasting our RTT to peers every 3 s so the sidebar can
      // show each participant's own ping, not just ours. Tiny payload —
      // negligible bandwidth.
      if (this.rttBroadcastTimer) clearInterval(this.rttBroadcastTimer);
      this.rttBroadcastTimer = setInterval(() => {
        void this.broadcastOwnRtt();
      }, 3000);
      this.emit();
    });
    this.room.on(RoomEvent.Disconnected, (reason?: DisconnectReason) => {
      this.connected = false;
      this.reconnecting = false;
      this.disconnectKind = mapDisconnectReason(reason);
      if (this.rttBroadcastTimer) {
        clearInterval(this.rttBroadcastTimer);
        this.rttBroadcastTimer = null;
      }
      this.emit();
    });
    // Media/signal blip recovery. The SDK keeps `connected` true through this,
    // so without surfacing `reconnecting` the UI would show a healthy call
    // while audio is actually cut. Reconnecting → banner; Reconnected clears it.
    this.room.on(RoomEvent.Reconnecting, () => {
      this.reconnecting = true;
      this.emit();
    });
    this.room.on(RoomEvent.Reconnected, () => {
      this.reconnecting = false;
      this.emit();
    });

    // Track RTT broadcasts from peers and stash them in our snapshot.
    this.room.on(
      RoomEvent.DataReceived,
      (payload: Uint8Array, participant?: RemoteParticipant) => {
        if (!participant) return;
        try {
          const msg = JSON.parse(new TextDecoder().decode(payload)) as {
            kind?: string;
            rttMs?: number;
            share?: string;
            x?: number;
            y?: number;
          };
          if (msg.kind === "rv:ptr" && typeof msg.share === "string" && typeof msg.x === "number" && typeof msg.y === "number") {
            // Collaborative pointer — kept OUT of the room snapshot so it can't
            // trigger the in-call re-render storm; the overlay reads the store
            // on its own rAF.
            setRemotePointer({
              id: participant.identity,
              share: msg.share,
              x: msg.x,
              y: msg.y,
              name: participant.name || participant.identity,
            });
            return;
          }
          if (msg.kind === "rv:ptr-off") {
            clearRemotePointer(participant.identity);
            return;
          }
          if (msg.kind !== "rv:rtt" || typeof msg.rttMs !== "number") return;
          this.rttByParticipant = {
            ...this.rttByParticipant,
            [participant.identity]: msg.rttMs,
          };
          this.emit();
        } catch {
          /* not for us */
        }
      },
    );

    this.room.on(RoomEvent.ParticipantDisconnected, (p) => {
      clearRemotePointer(p.identity);
      if (p.identity in this.rttByParticipant) {
        const next = { ...this.rttByParticipant };
        delete next[p.identity];
        this.rttByParticipant = next;
      }
    });
    this.room.on(RoomEvent.ParticipantConnected, (p) => {
      notifyJoinLeave(p.name || p.identity, "joined");
      this.emit();
    });
    this.room.on(RoomEvent.ParticipantDisconnected, (p) => {
      notifyJoinLeave(p.name || p.identity, "left");
      this.emit();
    });
    this.room.on(RoomEvent.TrackSubscribed, (track, pub, participant) => {
      // Receiver-side stats sampling for remote video tracks. Mirrors the
      // sender-side block in LocalTrackPublished — together they reveal
      // whether the bottleneck is at the publisher (low fps encoded), in
      // transit (TCP relay / packet loss / BWE), or at the decoder (slow
      // software decode → freezes). Critical for diagnosing the
      // remote-screenshare-1fps complaint that sender-side overrides
      // alone can't fix.
      if (track.kind === "video") {
        const rtrack = track as RemoteTrack;
        const sample = async (): Promise<void> => {
          try {
            const report = await rtrack.getRTCStatsReport();
            if (!report) return;
            for (const r of report.values() as Iterable<{ type: string; kind?: string; [k: string]: unknown }>) {
              if (r.type !== "inbound-rtp" || r.kind !== "video") continue;
              const fps = (r["framesPerSecond"] as number | undefined) ?? 0;
              const decoded = (r["framesDecoded"] as number | undefined) ?? 0;
              const dropped = (r["framesDropped"] as number | undefined) ?? 0;
              const freezes = (r["freezeCount"] as number | undefined) ?? 0;
              const freezeDur = (r["totalFreezesDuration"] as number | undefined) ?? 0;
              const bytes = (r["bytesReceived"] as number | undefined) ?? 0;
              const decoder = (r["decoderImplementation"] as string | undefined) ?? "?";
              const mime = (r["mimeType"] as string | undefined) ?? "?";
              const jit = r["jitter"] as number | undefined;
              const nack = (r["nackCount"] as number | undefined) ?? 0;
              const pli = (r["pliCount"] as number | undefined) ?? 0;
              const fir = (r["firCount"] as number | undefined) ?? 0;
              const w = (r["frameWidth"] as number | undefined) ?? "?";
              const h = (r["frameHeight"] as number | undefined) ?? "?";
              const lost = (r["packetsLost"] as number | undefined) ?? 0;
              // eslint-disable-next-line no-console
              console.log(
                `[recv:${participant.identity}/${pub.source}] ` +
                  `fps=${typeof fps === "number" ? fps.toFixed(1) : fps} ` +
                  `${w}x${h} decoded=${decoded} dropped=${dropped} ` +
                  `freezes=${freezes} freezeDur=${freezeDur.toFixed(1)}s ` +
                  `bytes=${(bytes / 1024).toFixed(0)}KB ` +
                  `decoder=${decoder} codec=${mime} ` +
                  `jitter=${jit != null ? (jit * 1000).toFixed(0) + "ms" : "?"} ` +
                  `lost=${lost} nack=${nack} pli=${pli} fir=${fir}`,
              );
            }
          } catch {
            /* */
          }
        };
        const handle = setInterval(() => void sample(), 3000);
        // First read after 1.5s and full ICE-pair log — gives a baseline
        // before BWE has stabilised.
        setTimeout(() => void sample(), 1500);
        void logIceCandidatePair(
          `recv:${participant.identity}/${pub.source}`,
          () => rtrack.getRTCStatsReport(),
        );
        const onUnsub = (
          _t: RemoteTrack,
          unsubPub: RemoteTrackPublication,
        ): void => {
          if (unsubPub.trackSid === pub.trackSid) {
            clearInterval(handle);
            this.room.off(RoomEvent.TrackUnsubscribed, onUnsub);
          }
        };
        this.room.on(RoomEvent.TrackUnsubscribed, onUnsub);
      }
      this.emit();
    });
    this.room.on(RoomEvent.TrackUnsubscribed, () => this.emit());
    // Mute/unmute changes flip whether a publication's track produces
    // frames. The UI's findScreenTrack/findCameraTrack filter out muted
    // pubs (so muted tiles fall back to the avatar instead of staying
    // black), so the snapshot needs to recompute on these events.
    this.room.on(RoomEvent.TrackMuted, () => this.emit());
    this.room.on(RoomEvent.TrackUnmuted, () => this.emit());
    this.room.on(RoomEvent.ActiveSpeakersChanged, () => this.emit());
    // Ghost state travels as a participant attribute (deck: Ghost replaces
    // Deafen — mic+cam off together, visible to everyone as 👻).
    this.room.on(RoomEvent.ParticipantAttributesChanged, () => this.emit());
    this.room.on(RoomEvent.LocalTrackPublished, (pub) => {
      // pub.mimeType is empty at publish time — SDP negotiation hasn't
      // settled. Poll the RTCRtpSender's getParameters() after a beat
      // for the actually-negotiated codec. Critical diagnostic for the
      // 1 fps screenshare report (vp8 fallback vs h264 chosen).
      const reportCodec = (): void => {
        try {
          const t = pub.track as unknown as {
            sender?: RTCRtpSender;
          } | undefined;
          const params = t?.sender?.getParameters?.();
          const codec = params?.codecs?.[0]?.mimeType ?? pub.mimeType ?? "unknown";
          // eslint-disable-next-line no-console
          console.log(
            `[livekit] published ${pub.source} kind=${pub.kind} ` +
              `codec=${codec} ` +
              `dims=${pub.dimensions?.width ?? "?"}x${pub.dimensions?.height ?? "?"}`,
          );
        } catch { /* logging only */ }
      };
      // First read after 1.5s (negotiation usually done), again at 5s in
      // case of slow SDP — covers screenshare which negotiates separately.
      setTimeout(reportCodec, 1500);
      setTimeout(reportCodec, 5000);

      // Periodic stats sampling for video tracks — tells us why receivers
      // see 1 fps despite H.264 being negotiated:
      //   qualityLimitationReason="cpu"        → encoder CPU bound
      //   qualityLimitationReason="bandwidth"  → BWE throttling (uplink)
      //   high target_fps + low encoded_fps    → encoder dropping frames
      //   high encoded_fps                     → problem is downstream (SFU / receiver)
      if (pub.kind === "video") {
        const t = pub.track as unknown as { sender?: RTCRtpSender } | undefined;
        const sender = t?.sender;
        if (sender?.getStats) {
          const sample = async (): Promise<void> => {
            try {
              const stats = await sender.getStats();
              for (const r of stats.values()) {
                if (r.type !== "outbound-rtp" || r.kind !== "video") continue;
                const reason = (r as { qualityLimitationReason?: string }).qualityLimitationReason ?? "?";
                const encFps = (r as { framesPerSecond?: number }).framesPerSecond ?? 0;
                const encImpl = (r as { encoderImplementation?: string }).encoderImplementation ?? "?";
                const targetBr = (r as { targetBitrate?: number }).targetBitrate ?? 0;
                const totalBytesSent = (r as { bytesSent?: number }).bytesSent ?? 0;
                const framesSent = (r as { framesSent?: number }).framesSent ?? 0;
                const framesEncoded = (r as { framesEncoded?: number }).framesEncoded ?? 0;
                const droppedDueLimit =
                  ((r as { qualityLimitationDurations?: Record<string, number> }).qualityLimitationDurations) ?? {};
                // eslint-disable-next-line no-console
                console.log(
                  `[stats:${pub.source}] enc=${encFps.toFixed(1)}fps impl=${encImpl} ` +
                    `qLimit=${reason} targetBr=${(targetBr / 1000).toFixed(0)}kbps ` +
                    `framesEncoded=${framesEncoded} framesSent=${framesSent} ` +
                    `bytesSent=${(totalBytesSent / 1024).toFixed(0)}KB ` +
                    `qLimitDur=${JSON.stringify(droppedDueLimit)}`,
                );
              }
            } catch { /* */ }
          };
          const handle = setInterval(() => void sample(), 3000);
          // Stop sampling on unpublish.
          const onUnpub = (p: { trackSid?: string }): void => {
            if (p.trackSid === pub.trackSid) {
              clearInterval(handle);
              this.room.off(RoomEvent.LocalTrackUnpublished, onUnpub);
            }
          };
          this.room.on(RoomEvent.LocalTrackUnpublished, onUnpub);
        }
      }
      this.emit();
    });
    this.room.on(RoomEvent.LocalTrackUnpublished, () => this.emit());
    this.room.on(RoomEvent.ConnectionStateChanged, () => this.emit());
    this.room.on(RoomEvent.ConnectionQualityChanged, () => this.emit());
  }

  subscribe(listener: RoomStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  snapshot(): RoomStateSnapshot {
    return this.cachedSnapshot;
  }

  private cachedRemotes: RemoteParticipant[] = [];
  private remotesKey = "\u0000";

  private computeSnapshot(): RoomStateSnapshot {
    // Only rebuild the remotes array when the participant SET changes — a new
    // array reference on every emit needlessly re-runs the volume effects
    // (which loop all remotes) on every speaker/RTT/quality tick.
    const rs = Array.from(this.room.remoteParticipants.values());
    const key = rs.map((r) => r.identity).join(",");
    if (key !== this.remotesKey) {
      this.remotesKey = key;
      this.cachedRemotes = rs;
    }
    return {
      connected: this.connected,
      reconnecting: this.reconnecting,
      local: this.room.localParticipant,
      remotes: this.cachedRemotes,
      error: this.err,
      screenShareAudioEnabled: this.room.localParticipant.getTrackPublication(
        Track.Source.ScreenShareAudio,
      ) != null,
      disconnectKind: this.disconnectKind,
      e2eeEnabled: this.e2eeEnabled,
      rttByParticipant: this.rttByParticipant,
    };
  }

  private async broadcastOwnRtt(): Promise<void> {
    const stats = await this.getNetworkStats();
    if (!stats || stats.rttMs == null) return;
    const rttMs = Math.round(stats.rttMs);
    // Mirror our own RTT into the snapshot so the local row shows the same
    // metric as the per-peer rows (single rendering path).
    this.rttByParticipant = {
      ...this.rttByParticipant,
      [this.room.localParticipant.identity]: rttMs,
    };
    this.emit();
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ kind: "rv:rtt", rttMs }));
      await this.room.localParticipant.publishData(payload, { reliable: false });
    } catch {
      /* mid-disconnect or no peers; harmless */
    }
  }

  /** Broadcast our pointer position on a given sharer's screen (lossy, high-freq). */
  async broadcastPointer(share: string, x: number, y: number): Promise<void> {
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ kind: "rv:ptr", share, x, y }));
      await this.room.localParticipant.publishData(payload, { reliable: false });
    } catch {
      /* no peers / mid-disconnect */
    }
  }

  /** Tell peers to remove our pointer. */
  async clearPointer(): Promise<void> {
    try {
      const payload = new TextEncoder().encode(JSON.stringify({ kind: "rv:ptr-off" }));
      await this.room.localParticipant.publishData(payload, { reliable: true });
    } catch {
      /* */
    }
  }

  /**
   * Set the shared E2EE key for this room. Once set, all subsequently-
   * published frames are SFrame-encrypted, and incoming frames are
   * decrypted with the same key. Pass an ArrayBuffer of 32 random bytes
   * for HKDF-derived keys (recommended).
   */
  async setRoomKey(rawKey: ArrayBuffer): Promise<void> {
    if (!this.keyProvider) return; // E2EE wasn't enabled at construction
    await this.keyProvider.setKey(rawKey);
    await this.room.setE2EEEnabled(true);
    this.e2eeEnabled = true;
    this.emit();
  }

  /** Disable E2EE on this room (revert to plaintext). */
  async clearRoomKey(): Promise<void> {
    if (!this.e2eeEnabled) return;
    await this.room.setE2EEEnabled(false);
    this.e2eeEnabled = false;
    this.emit();
  }

  private emitScheduled = false;
  private emit(): void {
    // Coalesce bursts of LiveKit events (speaker/RTT/quality can fire many
    // times per second) into at most one snapshot + notify per animation
    // frame, so subscribers re-render ≤60 Hz instead of per-event.
    if (this.emitScheduled) return;
    this.emitScheduled = true;
    const flush = (): void => {
      this.emitScheduled = false;
      this.cachedSnapshot = this.computeSnapshot();
      for (const l of this.listeners) l(this.cachedSnapshot);
    };
    if (typeof requestAnimationFrame === "function") requestAnimationFrame(flush);
    else setTimeout(flush, 16);
  }

  async join(options: JoinOptions): Promise<void> {
    try {
      await this.room.connect(options.wsUrl, options.token);
    } catch (err) {
      this.err = err instanceof Error ? err.message : "failed to connect";
      this.connected = false;
      this.emit();
      throw err;
    }
    // Publish mic only if explicitly requested (voice deferred to Plan 4
    // pending codec-collision investigation with livekit-client 2.x).
    if (options.publishAudio) {
      if (options.micStream) {
        const [micTrack] = options.micStream.getAudioTracks();
        if (micTrack) {
          await this.room.localParticipant.publishTrack(micTrack, MIC_PUBLISH_OPTIONS);
        }
      } else {
        await this.room.localParticipant.setMicrophoneEnabled(true, undefined, MIC_PUBLISH_OPTIONS);
      }
    }
    // Publish screenshare. We always start the video share with audio:false
    // and route audio through enableScreenShareAudio() so the toggle works
    // uniformly whether requested at join time or flipped mid-room.
    if (options.publishScreen) {
      const q = options.screenQuality;
      if (q) {
        await this.publishScreenShareWithQuality(q);
      } else {
        await this.room.localParticipant.setScreenShareEnabled(true);
        this.applyScreenShareSenderOverrides({});
      }
    }
  }

  /**
   * Publish the screenshare video track at an explicit resolution/fps, wiring
   * the encoder + transport overrides and optional system-audio capture.
   * Shared by the join-time path and the in-room quality dialog so both start
   * a share identically (same bitrate curve, contentHint, degradation policy).
   */
  private async publishScreenShareWithQuality(q: ScreenShareQuality): Promise<void> {
    await this.room.localParticipant.setScreenShareEnabled(
      true,
      {
        resolution: { width: q.width, height: q.height, frameRate: q.frameRate },
        audio: false,
        // "detail" (not "motion") tells the encoder this is screen content:
        // it favors spatial sharpness (readable text/UI) and, with
        // maintain-resolution below, sheds framerate before it blurs the
        // picture — the right tradeoff for sharing a screen. "motion" was
        // making text mushy and wasting bitrate on frame-rate it couldn't
        // sustain.
        contentHint: q.frameRate >= 50 ? "motion" : "detail",
      },
      {
        screenShareEncoding: {
          maxBitrate: computeScreenShareBitrate(q.width, q.height, q.frameRate),
          maxFramerate: q.frameRate,
          priority: "high",
        },
        videoCodec: "vp9",
        // High-fps shares (games) want smoothness; everything else keeps
        // resolution and drops fps so text stays sharp under congestion.
        degradationPreference: q.frameRate >= 50 ? "maintain-framerate" : "maintain-resolution",
      },
    );
    this.applyScreenShareSenderOverrides({ sourceWidth: q.width, sourceHeight: q.height });
    if (q.audioSource !== null) {
      await this.enableScreenShareAudio(q.audioSource === "all" ? undefined : q.audioSource);
    }
  }

  /**
   * Reach into the underlying RTCRtpSender of the active screenshare track
   * and force the encoder/transport overrides we need:
   *   - degradationPreference = "maintain-framerate"
   *   - encodings[].priority + networkPriority = "high"
   *   - scaleResolutionDownBy = 1.5 (1080p → 720p) when source is ≥1080p
   *
   * Why: LiveKit's TrackPublishOptions don't reliably propagate these into
   * the RTCRtpSender, and Chromium's MFT H.264 path doesn't honour
   * mid-stream resolution change anyway. Pre-scaling at the sender means
   * the encoder never has to dynamically downscale — it gets 720p frames
   * directly, which fits in ~1.5 Mbps BWE budget at 60 fps cleanly.
   *
   * Idempotent: safe to call from join() AND from in-room toggle, both
   * code paths now route through here so the override applies regardless
   * of how the share was started.
   */
  private applyScreenShareSenderOverrides(opts: {
    sourceWidth?: number;
    sourceHeight?: number;
  }): void {
    try {
      const screenPub = this.room.localParticipant.getTrackPublication(
        Track.Source.ScreenShare,
      );
      // Force contentHint="motion" on the underlying MediaStreamTrack — this
      // tells WebRTC's H.264 encoder to maintain framerate even when scene
      // motion is low. Default contentHint for screen capture is "detail",
      // which encodes only when content changes → ~1 fps on a mostly-static
      // desktop. The join() publish path sets this via setScreenShareEnabled
      // options; the in-room toggle path doesn't, so we set it here so both
      // code paths get the same behaviour.
      const mst = screenPub?.track?.mediaStreamTrack;
      if (mst && mst.contentHint !== "motion") {
        mst.contentHint = "motion";
        // eslint-disable-next-line no-console
        console.log(`[screenshare] track.contentHint = "motion"`);
      }
      const sender = (screenPub?.track as unknown as { sender?: RTCRtpSender } | undefined)?.sender;
      if (!sender) return;

      const w = opts.sourceWidth ?? 1920;
      const h = opts.sourceHeight ?? 1080;
      const shouldScaleDown = w >= 1920 || h >= 1080;

      // setParameters rejects the *whole* call if even one field is
      // "unimplemented" in this Chromium build. v0.5.9 hit this on
      // legacy `priority`. v0.5.10 switched to `networkPriority` but
      // diagnostics show the "full" tier still gets rejected on Electron
      // 35 / Chromium for screenshare — likely degradationPreference
      // can't co-occur with networkPriority in setParameters() in this
      // build. The previous tiered fallback meant if "full" failed, we
      // dropped networkPriority entirely — leaving Chromium's screenshare
      // default of `low`, which is *worse* than "medium" default for
      // real-time tracks.
      //
      // Now: each parameter is applied in its own setParameters call.
      // Whatever Chromium accepts, we keep — partial success across the
      // whole set instead of all-or-nothing.
      const applyOne = async (
        mutate: (p: RTCRtpSendParameters) => void,
        label: string,
      ): Promise<void> => {
        try {
          const p = sender.getParameters();
          mutate(p);
          await sender.setParameters(p);
          // eslint-disable-next-line no-console
          console.log(`[screenshare] override applied (${label})`);
        } catch (err) {
          // eslint-disable-next-line no-console
          console.warn(`[screenshare] override "${label}" rejected:`, err);
        }
      };

      void (async (): Promise<void> => {
        // Most important: bump screenshare priority above default. Without
        // this, screenshare yields to other traffic on the same connection.
        await applyOne((p) => {
          for (const enc of p.encodings ?? []) {
            enc.networkPriority = "high";
          }
        }, "netPriority=high");

        // Second: tell the encoder to drop resolution before frames when
        // bandwidth-pressured. Source content is mostly motion (gameplay).
        await applyOne((p) => {
          p.degradationPreference = "maintain-framerate";
        }, "degradation=maintain-framerate");

        // Third: pre-scale 1080p+ source down to ~720p so the encoder has
        // an easier job under sustained load. Skip when source is already
        // small enough — scaling 720p down to 480p hurts more than helps.
        if (shouldScaleDown) {
          await applyOne((p) => {
            for (const enc of p.encodings ?? []) {
              enc.scaleResolutionDownBy = 1.5;
            }
          }, "scaleDown=1.5");
        }
      })();

      // Verify what actually stuck — cur values reveal whether the override
      // landed or got reverted by LiveKit / the encoder.
      const verifyHandle = setInterval(() => {
        try {
          const cur = sender.getParameters();
          // eslint-disable-next-line no-console
          console.log(
            `[screenshare] params check — deg=${cur.degradationPreference} ` +
              `enc[0].scaleDownBy=${cur.encodings?.[0]?.scaleResolutionDownBy ?? 1} ` +
              `enc[0].netPriority=${cur.encodings?.[0]?.networkPriority ?? "?"} ` +
              `enc[0].active=${cur.encodings?.[0]?.active ?? true}`,
          );
        } catch { /* */ }
      }, 5000);
      const onUnpub = (p: { source?: Track.Source }): void => {
        if (p.source === Track.Source.ScreenShare) {
          clearInterval(verifyHandle);
          this.room.off(RoomEvent.LocalTrackUnpublished, onUnpub);
        }
      };
      this.room.on(RoomEvent.LocalTrackUnpublished, onUnpub);
    } catch (err) {
      // eslint-disable-next-line no-console
      console.warn("[screenshare] failed to set sender params:", err);
    }
  }

  /**
   * Publish a screen_share_audio track. Capture order:
   *   1. Native WASAPI filter (Windows 11+, excludes R3DVoice's own playback)
   *   2. Linux PipeWire venmic device (per-app or system-mix-minus-self)
   *   3. getDisplayMedia({audio:true, video:false}) — Windows fallback
   *
   * `includeProcessId` restricts capture to a single app: a process.id
   * string for Linux/venmic, or a numeric PID (as string) on Windows for
   * the WASAPI helper's --include-pid mode.
   */
  async enableScreenShareAudio(includeProcessId?: string): Promise<boolean> {
    if (this.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio)) {
      return true;
    }

    const platform = window.r3dvoice?.platform();

    let track: MediaStreamTrack | null = null;
    let auxStream: MediaStream | null = null;

    // 1. Native WASAPI filter
    if (platform === "win32") {
      try {
        const winPid = includeProcessId ? Number.parseInt(includeProcessId, 10) : undefined;
        const stream = await startSystemAudioStream(
          Number.isFinite(winPid) ? { includePid: winPid as number } : {},
        );
        track = stream?.getAudioTracks()[0] ?? null;
      } catch { /* */ }
      if (track) {
        // eslint-disable-next-line no-console
        console.log(
          includeProcessId
            ? `[screenshare] capturing PID ${includeProcessId} via WASAPI`
            : "[screenshare] system audio filtered via native helper (your voice excluded)",
        );
      }
    }

    // 2. Linux: ask main to set up a virtual sink that excludes R3DVoice's
    //    playback, then capture from its monitor. Falls back to the full
    //    system-mix monitor if pactl isn't available.
    if (!track && platform === "linux") {
      let preferLabel: string | undefined;
      let routingEnabled = false;
      try {
        const routing = await window.r3dvoice.enableLinuxAudioRouting(
          includeProcessId ? { includeProcessId } : undefined,
        );
        if (routing) {
          preferLabel = routing.monitorDeviceDescription;
          routingEnabled = true;
        }
      } catch { /* */ }

      auxStream = await captureLinuxMonitorSource(preferLabel);
      track = auxStream?.getAudioTracks()[0] ?? null;
      if (track) {
        // eslint-disable-next-line no-console
        console.log(
          routingEnabled
            ? "[screenshare] linux: capturing r3dvoice_share.monitor — R3DVoice playback excluded"
            : "[screenshare] linux: capturing default monitor (system mix; use headphones to avoid echo)",
        );
      } else if (routingEnabled) {
        // Capture failed even though routing was set up — tear it down so
        // we don't leave the user's audio rerouted.
        try { await window.r3dvoice.disableLinuxAudioRouting(); } catch { /* */ }
      }
    }

    // 3. getDisplayMedia audio fallback — for Windows (native WASAPI helper
    //    unavailable) and web (the browser's own picker carries an audio
    //    checkbox). Explicitly NOT Linux: there, audio-only getDisplayMedia
    //    still pops the screen portal a SECOND time (Wayland/PipeWire has no
    //    audio-only capture through this API), which is exactly the "asked me
    //    to pick a screen twice" bug. On Linux the PipeWire monitor path above
    //    is the only correct route; if it didn't yield a track we go without
    //    share-audio rather than double-prompting the portal.
    if (!track && platform !== "linux") {
      try {
        const stream = await navigator.mediaDevices.getDisplayMedia({
          audio: true,
          video: false,
        } as DisplayMediaStreamOptions);
        track = stream.getAudioTracks()[0] ?? null;
        stream.getVideoTracks().forEach((t) => t.stop());
        if (track) {
          auxStream = stream;
          // eslint-disable-next-line no-console
          console.log("[screenshare] system audio NOT filtered — others may hear themselves; use headphones");
        }
      } catch {
        return false;
      }
    }

    if (!track) return false;

    this.screenAudioAuxStream = auxStream;
    // High-quality stereo Opus for screenshare audio. The LiveKit default
    // is a speech preset (~24 kbps mono) which butchers music/game audio.
    // dtx (discontinuous transmission) drops silent frames — fine for voice,
    // but it kills tail/decay on music. red (redundant encoding) adds
    // latency, also undesirable here. forceStereo keeps both channels.
    await this.room.localParticipant.publishTrack(track, {
      source: Track.Source.ScreenShareAudio,
      audioPreset: AudioPresets.musicHighQualityStereo,
      dtx: false,
      red: false,
      forceStereo: true,
    });
    this.emit();
    return true;
  }

  /** Unpublish the active screen_share_audio track and release the source. */
  async disableScreenShareAudio(): Promise<void> {
    const pub = this.room.localParticipant.getTrackPublication(Track.Source.ScreenShareAudio);
    if (pub?.track) {
      try { await this.room.localParticipant.unpublishTrack(pub.track); } catch { /* */ }
    }
    if (this.screenAudioAuxStream) {
      this.screenAudioAuxStream.getTracks().forEach((t) => t.stop());
      this.screenAudioAuxStream = null;
    }
    await stopSystemAudioStream();
    try { await window.r3dvoice?.disableLinuxAudioRouting?.(); } catch { /* */ }
    this.emit();
  }

  async setMuted(muted: boolean): Promise<void> {
    await this.room.localParticipant.setMicrophoneEnabled(!muted);
    this.emit();
  }

  /** Ghost = mic + cam off together, advertised to peers via attributes. */
  async setGhost(on: boolean): Promise<void> {
    if (on) {
      await this.room.localParticipant.setMicrophoneEnabled(false);
      if (this.room.localParticipant.isCameraEnabled) {
        await this.room.localParticipant.setCameraEnabled(false);
      }
    } else {
      await this.room.localParticipant.setMicrophoneEnabled(true);
    }
    await this.room.localParticipant.setAttributes({ ghost: on ? "1" : "" });
    this.emit();
  }

  /**
   * Pull network stats for the local mic track from the underlying RTCPeerConnection.
   * roundTripTime is the RTT in ms reported by the receiver (server) → roughly 2× the
   * one-way audio latency. jitter and packetsLost help diagnose stalls; with multi-second
   * voice delay, jitter buffer ramp-up from packet loss is the usual cause.
   *
   * Returns null if no stats are available (no track / not connected yet).
   */
  async getNetworkStats(): Promise<{
    rttMs: number | null;
    jitterMs: number | null;
    packetsLost: number | null;
    bitrateKbps: number | null;
  } | null> {
    const audioPub = Array.from(this.room.localParticipant.audioTrackPublications.values()).find(
      (p) => p.source === Track.Source.Microphone,
    );
    if (!audioPub?.track) return null;
    const report = await audioPub.track.getRTCStatsReport();
    if (!report) return null;

    let rttMs: number | null = null;
    let jitterMs: number | null = null;
    let packetsLost: number | null = null;
    let bitrateKbps: number | null = null;

    report.forEach((stat: { type: string; [k: string]: unknown }) => {
      if (stat.type === "remote-inbound-rtp") {
        const rtt = stat["roundTripTime"];
        if (typeof rtt === "number") rttMs = rtt * 1000;
        const jit = stat["jitter"];
        if (typeof jit === "number") jitterMs = jit * 1000;
        const lost = stat["packetsLost"];
        if (typeof lost === "number") packetsLost = lost;
      }
      if (stat.type === "outbound-rtp") {
        const br = stat["targetBitrate"];
        if (typeof br === "number") bitrateKbps = br / 1000;
      }
    });

    return { rttMs, jitterMs, packetsLost, bitrateKbps };
  }

  async setScreenShare(enabled: boolean, quality?: ScreenShareQuality): Promise<void> {
    if (enabled && quality) {
      // In-room quality dialog path — publish at the chosen resolution/fps and
      // (optionally) system audio, using the exact same encoder/transport
      // overrides as the join-time path.
      await this.publishScreenShareWithQuality(quality);
    } else {
      await this.room.localParticipant.setScreenShareEnabled(enabled);
      if (enabled) {
        // Apply the same encoder/transport overrides the join-time path uses
        // — without this, in-room toggle gets LiveKit defaults (no
        // degradationPreference, no scale-down, no priority) and screenshare
        // collapses to ~1 fps under any BWE pressure.
        this.applyScreenShareSenderOverrides({});
      }
    }
    this.emit();
  }

  async setCamera(enabled: boolean, deviceId?: string): Promise<void> {
    const opts = enabled && deviceId ? { deviceId: { exact: deviceId } } : undefined;
    try {
      await this.room.localParticipant.setCameraEnabled(enabled, opts);
    } catch (err) {
      // Stale/absent exact device id (e.g. the web client's device ids differ
      // from the desktop app's) rejects without prompting — retry with the
      // default camera so it actually opens + prompts.
      if (enabled && opts && err instanceof DOMException && (err.name === "OverconstrainedError" || err.name === "NotFoundError")) {
        await this.room.localParticipant.setCameraEnabled(true);
      } else {
        throw err;
      }
    }
    this.emit();
  }

  /**
   * Live-switch the active camera without re-publishing. If the camera
   * isn't enabled yet, enables it with the chosen device instead.
   */
  async switchCamera(deviceId: string): Promise<void> {
    if (this.room.localParticipant.isCameraEnabled) {
      await this.room.switchActiveDevice("videoinput", deviceId);
    } else {
      await this.room.localParticipant.setCameraEnabled(true, {
        deviceId: { exact: deviceId },
      });
    }
    this.emit();
  }

  async leave(): Promise<void> {
    await this.disableScreenShareAudio();
    await this.room.disconnect();
    this.connected = false;
    this.emit();
  }

  /**
   * Send a chat message to every other participant via DataChannel.
   * Reliable delivery; ephemeral (no server-side persistence).
   */
  async sendChat(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) return;
    const payload = new TextEncoder().encode(
      JSON.stringify({ kind: "chat", text: trimmed, ts: Date.now() }),
    );
    await this.room.localParticipant.publishData(payload, { reliable: true });
  }

  /**
   * Subscribe to incoming chat messages. Returns unsubscribe.
   * `from` is the participant identity; `local` denotes self-echo.
   */
  onChat(
    cb: (msg: { from: string; fromName: string; text: string; ts: number; local: boolean }) => void,
  ): () => void {
    const handler = (
      payload: Uint8Array,
      participant?: RemoteParticipant,
      _kind?: DataPacket_Kind,
    ): void => {
      try {
        const obj = JSON.parse(new TextDecoder().decode(payload)) as {
          kind?: string;
          text?: string;
          ts?: number;
        };
        if (obj.kind !== "chat" || typeof obj.text !== "string") return;
        if (!participant) return;
        cb({
          from: participant.identity,
          fromName: participant.name || participant.identity,
          text: obj.text,
          ts: typeof obj.ts === "number" ? obj.ts : Date.now(),
          local: false,
        });
      } catch {
        /* drop malformed payloads */
      }
    };
    this.room.on(RoomEvent.DataReceived, handler);
    return () => {
      this.room.off(RoomEvent.DataReceived, handler);
    };
  }

  /**
   * Attach every subscribed remote audio track to a DOM element for playback.
   * Call once per remote audio track, idempotently. Returns detach function.
   */
  attachRemoteAudio(
    track: RemoteTrack,
    _pub: RemoteTrackPublication,
    _participant: RemoteParticipant,
  ): HTMLAudioElement {
    const element = track.attach() as HTMLAudioElement;
    element.autoplay = true;
    (element as HTMLElement & { playsInline?: boolean }).playsInline = true;
    return element;
  }
}

/* ────────────────────────────────────────────────────────────────────────
 * Per-participant voice GAIN graph (in-room 0–200% volume).
 *
 * HTMLMediaElement.volume is clamped to [0,1] and *throws* IndexSizeError
 * above 1, so LiveKit's setVolume can only attenuate, never boost. To let a
 * user push a quiet friend to 200% we route that participant's mic <audio>
 * element through Web Audio: MediaElementSource → GainNode → destination, and
 * the GainNode multiplies (it happily takes values >1).
 *
 * We only ever capture an element when a boost (>1) is actually requested —
 * default users (all volumes ≤1) keep the native element path untouched, so
 * mono-output.ts (which also captures elements, only when its toggle is on)
 * keeps working for everyone who never boosts. If both features want the same
 * element, whichever captures first wins and the other degrades silently
 * (a rare combination: mono output + an above-100% per-user boost).
 *
 * element.volume is still LiveKit-controlled for the 0..1 range and for
 * deafen/mute-for-me (setVolume(0)), which multiplies through the gain node
 * (0 × gain = silence), so those paths need no special-casing here.
 * ──────────────────────────────────────────────────────────────────────── */
let gainCtx: AudioContext | null = null;
const gainNodes = new Map<string, GainNode>();
const gainElements = new Map<string, HTMLAudioElement>();
const gainDesired = new Map<string, number>();
const gainCaptured = new WeakMap<HTMLAudioElement, GainNode>();

function ensureGainCtx(): AudioContext {
  if (!gainCtx) gainCtx = new AudioContext();
  if (gainCtx.state === "suspended") void gainCtx.resume();
  return gainCtx;
}

function captureForGain(key: string, el: HTMLAudioElement): GainNode | null {
  const existing = gainCaptured.get(el);
  if (existing) {
    gainNodes.set(key, existing);
    return existing;
  }
  try {
    const ctx = ensureGainCtx();
    const src = ctx.createMediaElementSource(el);
    const node = ctx.createGain();
    node.gain.value = gainDesired.get(key) ?? 1;
    src.connect(node);
    node.connect(ctx.destination);
    gainCaptured.set(el, node);
    gainNodes.set(key, node);
    return node;
  } catch {
    // Element already owned by another AudioContext (e.g. mono output) — can't
    // add gain. Leave it native; boost simply won't apply for this element.
    return null;
  }
}

/** Remember a participant's mic <audio> element; capture now if a boost is pending. */
export function registerParticipantGainElement(key: string, el: HTMLAudioElement): void {
  gainElements.set(key, el);
  if ((gainDesired.get(key) ?? 1) > 1) captureForGain(key, el);
}

/**
 * Set the post-attenuation gain multiplier for a participant (1 = unity).
 * Values >1 lazily capture the element into Web Audio; ≤1 is a no-op unless
 * the element was already captured, in which case we just reset the node.
 */
export function setParticipantGain(key: string, gain: number): void {
  const g = Number.isFinite(gain) && gain > 0 ? gain : 1;
  gainDesired.set(key, g);
  let node = gainNodes.get(key);
  if (!node && g > 1) {
    const el = gainElements.get(key);
    if (el) node = captureForGain(key, el) ?? undefined;
  }
  if (node) node.gain.value = g;
}

/** Drop a participant's gain bookkeeping when their track unsubscribes. */
export function unregisterParticipantGain(key: string): void {
  gainElements.delete(key);
  gainNodes.delete(key);
  gainDesired.delete(key);
}

/** Mirror the selected speaker onto the gain graph's context (captured
 * elements play through the AudioContext, not the element's own sinkId). */
export async function setParticipantGainSink(deviceId: string | null): Promise<void> {
  if (!gainCtx) return;
  const c = gainCtx as AudioContext & { setSinkId?: (id: string) => Promise<void> };
  if (typeof c.setSinkId === "function") {
    try {
      await c.setSinkId(deviceId ?? "");
    } catch {
      /* unsupported sink — default output */
    }
  }
}

// Re-export LiveKit types the UI layer needs directly.
export type { RemoteParticipant, LocalParticipant, RemoteTrack, RemoteTrackPublication } from "livekit-client";
export { Track, RoomEvent } from "livekit-client";
