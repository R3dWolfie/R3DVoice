import {
  useEffect,
  useRef,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import {
  listAudioInputs,
  listAudioOutputs,
  listVideoInputs,
  subscribeMicLevel,
  type DeviceInfo,
} from "../lib/media.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import type { CameraResolution, RoomNotifDefault, ThemePreset } from "../lib/prefs-store.js";
import {
  THEME_TOKENS,
  applyThemeOverrides,
  downloadThemeJson,
  isValidHex,
  parseThemeJson,
} from "../lib/theme-tokens.js";
import type { MediaPermissionStatus } from "../../../shared/bridge-types.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { clearKeyPair, downloadKeyBackup, loadKeyPair } from "../lib/key-storage.js";
import { Avatar } from "./Avatar.js";
import { I } from "./Icons.js";
import { Modal } from "./Modal.js";
import { Field, APP_VERSION } from "./Primitives.js";

type Tab = "devices" | "keybinds" | "account" | "theme" | "notifications" | "compat" | "about";

// Local copy of the designer's kbd inline style. Will be lifted to a shared
// helper once a third call site appears.
const kbdStyle: CSSProperties = {
  display: "inline-block",
  padding: "1px 6px",
  border: "1px solid var(--border-strong)",
  borderRadius: 4,
  background: "var(--bg-elev-2)",
  fontFamily: "var(--font-mono)",
  fontSize: 10,
  color: "var(--text)",
};

export function SettingsModal({ onClose }: { onClose: () => void }): ReactElement {
  const [tab, setTab] = useState<Tab>("devices");

  return (
    <Modal open={true} onClose={onClose} title="Settings">
      {/* Clamp to the viewport so the modal never clips off-screen and only
          the tab pane scrolls (single scrollbar). */}
      <div style={{ display: "grid", gridTemplateColumns: "200px 1fr", height: "min(540px, calc(82vh - 6rem))" }}>
        {/* Side nav */}
        <nav
          style={{
            borderRight: "1px solid var(--border-soft)",
            padding: "var(--s-4) var(--s-3)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          <NavButton
            active={tab === "devices"}
            onClick={() => setTab("devices")}
            icon={<I.Mic size={14} />}
            label="Devices"
          />
          <NavButton
            active={tab === "keybinds"}
            onClick={() => setTab("keybinds")}
            icon={<I.Settings size={14} />}
            label="Keybinds"
          />
          <NavButton
            active={tab === "account"}
            onClick={() => setTab("account")}
            icon={<I.Logout size={14} />}
            label="Account"
          />
          <NavButton
            active={tab === "theme"}
            onClick={() => setTab("theme")}
            icon={<I.StarFilled size={14} />}
            label="Theme"
          />
          <NavButton
            active={tab === "notifications"}
            onClick={() => setTab("notifications")}
            icon={<I.Bell size={14} />}
            label="Notifications"
          />
          <NavButton
            active={tab === "compat"}
            onClick={() => setTab("compat")}
            icon={<I.Grid size={14} />}
            label="Advanced"
          />
          <NavButton
            active={tab === "about"}
            onClick={() => setTab("about")}
            icon={<I.Star size={14} />}
            label="About"
          />
        </nav>

        {/* Body */}
        <div className="rv-scroll" style={{ padding: "var(--s-6) var(--s-7)", overflowY: "auto", minHeight: 0 }}>
          {tab === "devices" && <DevicesTab />}
          {tab === "keybinds" && <KeybindsTab />}
          {tab === "account" && <AccountTab onClose={onClose} />}
          {tab === "theme" && <ThemeTab />}
          {tab === "notifications" && <NotificationsTab />}
          {tab === "compat" && <CompatTab />}
          {tab === "about" && <AboutTab />}
        </div>
      </div>
    </Modal>
  );
}

function NavButton({
  active,
  onClick,
  icon,
  label,
}: {
  active: boolean;
  onClick: () => void;
  icon: ReactNode;
  label: string;
}): ReactElement {
  return (
    <button
      onClick={onClick}
      style={{
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        padding: "8px 10px",
        border: 0,
        cursor: "pointer",
        textAlign: "left",
        borderRadius: "var(--r-sm)",
        background: active
          ? "color-mix(in oklch, var(--accent) 14%, var(--bg-elev-2))"
          : "transparent",
        color: active ? "var(--text)" : "var(--text-mid)",
        fontSize: "var(--t-sm)",
        fontWeight: 500,
        borderLeft: active ? "2px solid var(--accent)" : "2px solid transparent",
        paddingLeft: 10,
      }}
    >
      {icon} {label}
    </button>
  );
}

function DevicesTab(): ReactElement {
  const [mics, setMics] = useState<DeviceInfo[]>([]);
  const [speakers, setSpeakers] = useState<DeviceInfo[]>([]);
  const micId = usePrefs((s) => s.micDeviceId);
  const spkId = usePrefs((s) => s.speakerDeviceId);

  useEffect(() => {
    let cancelled = false;
    void Promise.all([listAudioInputs(), listAudioOutputs()]).then(([ins, outs]) => {
      if (cancelled) return;
      setMics(ins);
      setSpeakers(outs);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-5)",
        maxWidth: 460,
      }}
    >
      <div className="rv-section-head">
        <span className="rv-label">Audio in / out</span>
      </div>
      <Field label="Microphone">
        <select
          className="rv-select"
          value={micId ?? ""}
          onChange={(e) => prefsActions().setMicDeviceId(e.target.value || null)}
        >
          {mics.length === 0 && <option value="">No mic detected</option>}
          {mics.map((m) => (
            <option key={m.deviceId} value={m.deviceId}>
              {m.label}
            </option>
          ))}
        </select>
      </Field>
      <MicLevelRow deviceId={micId} />
      <Field label="Speakers">
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <select
            className="rv-select"
            style={{ flex: 1, minWidth: 0 }}
            value={spkId ?? ""}
            onChange={(e) => prefsActions().setSpeakerDeviceId(e.target.value || null)}
          >
            {speakers.length === 0 && <option value="">Default output</option>}
            {speakers.map((s) => (
              <option key={s.deviceId} value={s.deviceId}>
                {s.label}
              </option>
            ))}
          </select>
          <SpeakerTestButton deviceId={spkId} />
        </div>
      </Field>
      <div
        style={{
          padding: "var(--s-3) var(--s-4)",
          background: "color-mix(in oklch, var(--rv-live) 10%, var(--bg-elev-2))",
          border: "1px solid color-mix(in oklch, var(--rv-live) 35%, var(--border))",
          borderRadius: "var(--r-md)",
          display: "flex",
          gap: "var(--s-3)",
          alignItems: "center",
          fontSize: "var(--t-sm)",
        }}
      >
        <span
          style={{
            width: 8,
            height: 8,
            borderRadius: "50%",
            background: "var(--rv-live)",
            boxShadow: "0 0 8px var(--rv-live)",
          }}
        />
        Microphone and speaker selection apply live. Processing settings apply on next mic open.
      </div>

      <div className="rv-section-head">
        <span className="rv-label">Mono</span>
      </div>
      <MonoControls />

      <div className="rv-section-head">
        <span className="rv-label">Processing</span>
      </div>
      <ProcessingControls />
      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: "var(--s-2)" }}>
        Changes apply on the next mic open (rejoin or PTT cycle).
      </div>

      <div className="rv-section-head">
        <span className="rv-label">Video</span>
      </div>
      <VideoSection />
    </div>
  );
}

// 3.1b — inline permission-denied block for mic/camera. The system blocked
// access; explain + offer retry (and the macOS request-permission path).
function PermissionDeniedBlock({
  kind,
  onRetry,
}: {
  kind: "microphone" | "camera";
  onRetry: () => void;
}): ReactElement {
  const isMac = window.r3dvoice.platform() === "darwin";
  const title = kind === "microphone" ? "Microphone access blocked" : "Camera access not granted";
  const copy =
    kind === "microphone"
      ? "R3DVoice can't reach your mic · the system has it locked. Open Settings → Privacy → Microphone and toggle R3DVoice on, then click Retry."
      : "Click Request access below and accept the system prompt. If you don't see it, the OS may have remembered a previous deny · open Settings → Privacy → Camera.";
  const request = (): void => {
    if (isMac) {
      void window.r3dvoice
        .askMediaPermission(kind)
        .then(() => onRetry())
        .catch(() => onRetry());
    } else {
      onRetry();
    }
  };
  return (
    <div className="rv-err-banner" role="alert">
      <span className="ic">!</span>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)", minWidth: 0 }}>
        <div style={{ fontWeight: 600 }}>{title}</div>
        <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", lineHeight: 1.5 }}>{copy}</div>
        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          {kind === "camera" && (
            <button
              type="button"
              className="rv-btn"
              style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
              onClick={request}
            >
              Request access
            </button>
          )}
          <button
            type="button"
            className="rv-btn"
            data-variant={kind === "microphone" ? undefined : "ghost"}
            style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
            onClick={onRetry}
          >
            Retry
          </button>
        </div>
      </div>
    </div>
  );
}

// 3.1 — live mic input level next to the mic select. Opens the selected
// device raw (no processing pipeline — we want the honest input level),
// meters via WebAudio, and releases everything on unmount/device change.
function MicLevelRow({ deviceId }: { deviceId: string | null }): ReactElement {
  const [blocked, setBlocked] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const fillRef = useRef<HTMLDivElement | null>(null);
  const dbRef = useRef<HTMLSpanElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    let stream: MediaStream | null = null;
    let unsub: (() => void) | null = null;
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) return;
    md.getUserMedia({
      audio: deviceId ? { deviceId: { exact: deviceId } } : true,
      video: false,
    })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setBlocked(false);
        unsub = subscribeMicLevel(s, (level) => {
          if (fillRef.current) fillRef.current.style.width = `${Math.round(level * 100)}%`;
          if (dbRef.current) {
            const db = level > 0 ? Math.max(-60, 20 * Math.log10(level)) : null;
            dbRef.current.textContent = db === null ? "−∞ dB" : `${db.toFixed(0)} dB`;
          }
        });
      })
      .catch(() => {
        if (!cancelled) setBlocked(true);
      });
    return () => {
      cancelled = true;
      unsub?.();
      stream?.getTracks().forEach((t) => t.stop());
    };
  }, [deviceId, retryNonce]);

  if (blocked) {
    return <PermissionDeniedBlock kind="microphone" onRetry={() => setRetryNonce((n) => n + 1)} />;
  }
  return (
    <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
      <span className="rv-label">in</span>
      <div className="rv-vu" style={{ flex: 1 }}>
        <div ref={fillRef} className="rv-vu-fill" style={{ width: "0%" }} />
        <div className="rv-vu-ticks" />
      </div>
      <span
        ref={dbRef}
        className="rv-mono"
        style={{ minWidth: 56, textAlign: "right", fontSize: "var(--t-xs)", color: "var(--text-dim)" }}
      >
        −∞ dB
      </span>
    </div>
  );
}

// 3.1 — speaker test: a short generated two-note chime through the selected
// output (WebAudio oscillator → element sink so setSinkId can route it).
function SpeakerTestButton({ deviceId }: { deviceId: string | null }): ReactElement {
  const [testing, setTesting] = useState(false);

  const play = (): void => {
    if (testing) return;
    setTesting(true);
    const ctx = new AudioContext();
    const dest = ctx.createMediaStreamDestination();
    const gain = ctx.createGain();
    gain.gain.value = 0;
    gain.connect(dest);
    const note = (freq: number, at: number, dur: number): void => {
      const osc = ctx.createOscillator();
      osc.type = "sine";
      osc.frequency.value = freq;
      osc.connect(gain);
      osc.start(ctx.currentTime + at);
      osc.stop(ctx.currentTime + at + dur);
    };
    gain.gain.setValueAtTime(0, ctx.currentTime);
    gain.gain.linearRampToValueAtTime(0.25, ctx.currentTime + 0.02);
    gain.gain.setValueAtTime(0.25, ctx.currentTime + 0.55);
    gain.gain.linearRampToValueAtTime(0, ctx.currentTime + 0.7);
    note(659.25, 0, 0.3); // E5
    note(880.0, 0.3, 0.4); // A5
    const audio = new Audio();
    audio.srcObject = dest.stream;
    const el = audio as HTMLMediaElement & { setSinkId?: (id: string) => Promise<void> };
    const sinkReady =
      deviceId && typeof el.setSinkId === "function" ? el.setSinkId(deviceId).catch(() => {}) : Promise.resolve();
    void sinkReady.then(() => audio.play()).catch(() => {});
    window.setTimeout(() => {
      audio.pause();
      audio.srcObject = null;
      void ctx.close().catch(() => {});
      setTesting(false);
    }, 800);
  };

  return (
    <button type="button" className="rv-btn" style={{ flex: "none" }} onClick={play} data-disabled={testing || undefined}>
      {testing ? "Testing…" : "Test"}
    </button>
  );
}

const CAMERA_RES: Array<{ key: CameraResolution; label: string; w: number; h: number }> = [
  { key: "480p", label: "640 × 480 · 30 fps", w: 640, h: 480 },
  { key: "720p", label: "1280 × 720 · 30 fps", w: 1280, h: 720 },
  { key: "1080p", label: "1920 × 1080 · 30 fps", w: 1920, h: 1080 },
];

// 3.1 / 3.1a — Video: camera select, live preview (released on stop/unmount),
// resolution select, mirror toggle. Permission denial renders the 3.1b block.
function VideoSection(): ReactElement {
  const camId = usePrefs((s) => s.cameraDeviceId);
  const camRes = usePrefs((s) => s.cameraResolution);
  const mirror = usePrefs((s) => s.cameraMirror);
  const [cams, setCams] = useState<DeviceInfo[]>([]);
  const [previewing, setPreviewing] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [actual, setActual] = useState<string | null>(null);
  const [retryNonce, setRetryNonce] = useState(0);
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    let cancelled = false;
    void listVideoInputs().then((list) => {
      if (!cancelled) setCams(list);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!previewing) return;
    let cancelled = false;
    let stream: MediaStream | null = null;
    const res = CAMERA_RES.find((r) => r.key === camRes) ?? CAMERA_RES[1]!;
    const md = globalThis.navigator?.mediaDevices;
    if (!md?.getUserMedia) return;
    md.getUserMedia({
      video: {
        ...(camId ? { deviceId: { exact: camId } } : {}),
        width: { ideal: res.w },
        height: { ideal: res.h },
        frameRate: { ideal: 30 },
      },
      audio: false,
    })
      .then((s) => {
        if (cancelled) {
          s.getTracks().forEach((t) => t.stop());
          return;
        }
        stream = s;
        setBlocked(false);
        const v = videoRef.current;
        if (v) {
          v.srcObject = s;
          void v.play().catch(() => {});
        }
        const track = s.getVideoTracks()[0];
        const st = track?.getSettings();
        if (st?.width && st.height) {
          const fps = st.frameRate ? ` · ${Math.round(st.frameRate)} fps` : "";
          setActual(`${st.width}×${st.height}${fps}`);
        } else {
          setActual(null);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setBlocked(true);
          setPreviewing(false);
        }
      });
    return () => {
      cancelled = true;
      if (videoRef.current) videoRef.current.srcObject = null;
      stream?.getTracks().forEach((t) => t.stop());
      setActual(null);
    };
  }, [previewing, camId, camRes, retryNonce]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
      <Field label="Camera">
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <select
            className="rv-select"
            style={{ flex: 1, minWidth: 0 }}
            value={camId ?? ""}
            onChange={(e) => prefsActions().setCameraDeviceId(e.target.value || null)}
          >
            {cams.length === 0 && <option value="">No camera detected</option>}
            {cams.map((c) => (
              <option key={c.deviceId} value={c.deviceId}>
                {c.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className="rv-btn"
            style={{ flex: "none" }}
            data-state={previewing ? "active" : undefined}
            onClick={() => {
              setBlocked(false);
              setPreviewing((p) => !p);
            }}
          >
            {previewing ? "■ Stop" : "▶ Preview"}
          </button>
        </div>
      </Field>

      {blocked && (
        <PermissionDeniedBlock
          kind="camera"
          onRetry={() => {
            setBlocked(false);
            setRetryNonce((n) => n + 1);
            setPreviewing(true);
          }}
        />
      )}

      {previewing && (
        <div
          style={{
            position: "relative",
            aspectRatio: "16 / 9",
            background: "var(--tile-bg)",
            border: "1px solid var(--border)",
            borderRadius: "var(--r-lg)",
            overflow: "hidden",
          }}
        >
          <video
            ref={videoRef}
            muted
            playsInline
            style={{
              width: "100%",
              height: "100%",
              objectFit: "cover",
              transform: mirror ? "scaleX(-1)" : undefined,
            }}
          />
          <span className="rv-badge" data-tone="live" style={{ position: "absolute", top: 8, left: 8 }}>
            <span className="pip" />
            live
          </span>
          {actual && (
            <span
              className="rv-mono"
              style={{
                position: "absolute",
                bottom: 8,
                right: 8,
                fontSize: "var(--t-2xs)",
                color: "#fff",
                background: "rgba(0,0,0,.55)",
                padding: "2px 8px",
                borderRadius: "var(--r-pill)",
              }}
            >
              {actual}
            </span>
          )}
        </div>
      )}

      <Field label="Resolution">
        <select
          className="rv-select"
          value={camRes}
          onChange={(e) => prefsActions().setCameraResolution(e.target.value as CameraResolution)}
        >
          {CAMERA_RES.map((r) => (
            <option key={r.key} value={r.key}>
              {r.label}
            </option>
          ))}
        </select>
      </Field>

      <SimpleToggle
        label="Mirror preview"
        hint="Flip the local view horizontally when previewing. Doesn't affect what others see."
        value={mirror}
        onChange={(v) => prefsActions().setCameraMirror(v)}
      />
    </div>
  );
}

// Mono in/out (task #12) — single-channel interfaces publish centered
// instead of left-ear-only; mono output plays the same mix in both ears.
function MonoControls(): ReactElement {
  const monoInput = usePrefs((s) => s.monoInput);
  const monoOutput = usePrefs((s) => s.monoOutput);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
      <SimpleToggle
        label="Mono microphone"
        hint="Downmix your mic to one centered channel. Turn on if your interface only feeds one side (listeners hear you in one ear)."
        value={monoInput}
        onChange={(v) => prefsActions().setMonoInput(v)}
      />
      <SimpleToggle
        label="Mono output"
        hint="Play everything the same in both ears — for single-ear headsets or asymmetric hearing. Applies live."
        value={monoOutput}
        onChange={(v) => prefsActions().setMonoOutput(v)}
      />
      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)" }}>
        Mono microphone applies on the next mic open (rejoin); mono output applies immediately.
      </div>
    </div>
  );
}

function ProcessingControls(): ReactElement {
  const ns = usePrefs((s) => s.noiseSuppression);
  const ec = usePrefs((s) => s.echoCancellation);
  const agc = usePrefs((s) => s.autoGainControl);
  const gain = usePrefs((s) => s.micGain);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div>
        <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>Noise suppression</div>
        <div style={{ display: "inline-flex", padding: 3, background: "var(--bg-elev-3)", border: "1px solid var(--border-soft)", borderRadius: "var(--r-md)", gap: 2 }}>
          {(["off", "low", "high"] as const).map((level) => (
            <button
              key={level}
              type="button"
              onClick={() => prefsActions().setNoiseSuppression(level)}
              style={{
                appearance: "none",
                border: 0,
                padding: "6px 14px",
                borderRadius: "calc(var(--r-md) - 3px)",
                background: ns === level ? "linear-gradient(180deg, var(--accent-hover), var(--accent))" : "transparent",
                color: ns === level ? "var(--on-accent)" : "var(--text-mid)",
                fontSize: "var(--t-sm)",
                fontFamily: "var(--font-mono)",
                cursor: "pointer",
              }}
            >
              {level}
            </button>
          ))}
        </div>
        <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 4 }}>
          Off / low / high. Drives WebRTC's NS pass; "high" is most aggressive.
        </div>
      </div>
      <SimpleToggle
        label="Auto-gain control"
        hint="Normalize speaking level"
        value={agc}
        onChange={(v) => prefsActions().setAutoGainControl(v)}
      />
      <SimpleToggle
        label="Echo cancellation"
        hint="Required if you use speakers"
        value={ec}
        onChange={(v) => prefsActions().setEchoCancellation(v)}
      />
      <div style={{ paddingTop: "var(--s-2)" }}>
        <div className="rv-label" style={{ marginBottom: "var(--s-2)" }}>
          Input gain
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <input
            type="range"
            min={0.5}
            max={3}
            step={0.05}
            value={gain}
            onChange={(e) => prefsActions().setMicGain(Number(e.target.value))}
            style={{ flex: 1, accentColor: "var(--accent)" }}
          />
          <span
            className="rv-mono"
            style={{ minWidth: 60, textAlign: "right", fontSize: "var(--t-sm)" }}
          >
            {gain.toFixed(2)}× ({gain === 1 ? "0.0" : (20 * Math.log10(gain)).toFixed(1)} dB)
          </span>
        </div>
        <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 4 }}>
          1.0 = unity. Anything else routes through Web Audio gain pipeline.
        </div>
      </div>
    </div>
  );
}

function SimpleToggle({
  label,
  hint,
  value,
  onChange,
}: {
  label: string;
  hint?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}): ReactElement {
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--s-4)",
        cursor: "pointer",
        padding: "10px 0",
        borderBottom: "1px solid var(--border-soft)",
      }}
    >
      <div>
        <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>{label}</div>
        {hint && <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2 }}>{hint}</div>}
      </div>
      <span
        onClick={() => onChange(!value)}
        style={{
          width: 36,
          height: 20,
          borderRadius: 999,
          background: value ? "var(--accent)" : "var(--bg-elev-3)",
          border: "1px solid " + (value ? "color-mix(in oklch, var(--accent) 70%, black)" : "var(--border-strong)"),
          position: "relative",
          transition: "all var(--d-base) var(--ease-out)",
          boxShadow: value ? "0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent)" : "none",
        }}
      >
        <span style={{ position: "absolute", top: 1, left: value ? 17 : 1, width: 16, height: 16, borderRadius: "50%", background: "var(--text)", transition: "left var(--d-base) var(--ease-out)" }} />
      </span>
    </label>
  );
}

function Toggle({
  label,
  hint,
  defaultChecked,
}: {
  label: string;
  hint?: string;
  defaultChecked?: boolean;
}): ReactElement {
  const [on, setOn] = useState<boolean>(!!defaultChecked);
  return (
    <label
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--s-4)",
        cursor: "pointer",
        padding: "10px 0",
        borderBottom: "1px solid var(--border-soft)",
      }}
    >
      <div>
        <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>{label}</div>
        {hint && (
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2 }}>
            {hint}
          </div>
        )}
      </div>
      <span
        onClick={() => setOn((o) => !o)}
        style={{
          width: 36,
          height: 20,
          borderRadius: 999,
          background: on ? "var(--accent)" : "var(--bg-elev-3)",
          border:
            "1px solid " +
            (on ? "color-mix(in oklch, var(--accent) 70%, black)" : "var(--border-strong)"),
          position: "relative",
          transition: "all var(--d-base) var(--ease-out)",
          boxShadow: on ? "0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent)" : "none",
        }}
      >
        <span
          style={{
            position: "absolute",
            top: 1,
            left: on ? 17 : 1,
            width: 16,
            height: 16,
            borderRadius: "50%",
            background: "var(--text)",
            transition: "left var(--d-base) var(--ease-out)",
          }}
        />
        <input
          type="checkbox"
          checked={on}
          onChange={() => {
            /* state mutates via the wrapper click */
          }}
          style={{ display: "none" }}
        />
      </span>
    </label>
  );
}

interface KeybindRowSpec {
  label: string;
  key:
    | "pttKeybind"
    | "muteKeybind"
    | "deafenKeybind"
    | "shareScreenKeybind"
    | "openSettingsKeybind"
    | "leaveRoomKeybind";
  global: boolean;
}

// Deck 3.2 rows — labels + defaults ship populated (see prefs-store DEFAULTS);
// unbound rows show the deck's dim "none" ghost text.
const KEYBIND_ROWS: KeybindRowSpec[] = [
  { label: "Push to talk", key: "pttKeybind", global: true },
  { label: "Mute / unmute", key: "muteKeybind", global: false },
  { label: "Toggle Ghost", key: "deafenKeybind", global: false },
  { label: "Share screen", key: "shareScreenKeybind", global: false },
  { label: "Open settings", key: "openSettingsKeybind", global: false },
  { label: "Leave room", key: "leaveRoomKeybind", global: false },
];

function KeybindsTab(): ReactElement {
  const [cheatsheetOpen, setCheatsheetOpen] = useState(false);
  return (
    <div
      style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", maxWidth: 460 }}
    >
      <div className="rv-section-head">
        <span className="rv-label" style={{ flex: 1 }}>Keybinds</span>
        <button
          type="button"
          className="rv-btn"
          style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
          onClick={() => setCheatsheetOpen(true)}
        >
          Cheatsheet
        </button>
      </div>
      {KEYBIND_ROWS.map((row) => (
        <KeybindRow key={row.key} spec={row} />
      ))}
      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: "var(--s-2)", lineHeight: 1.5 }}>
        Push-to-talk uses a system-wide hotkey (works when the app is unfocused).
        The rest only fire when the R3DVoice window is focused.
      </div>
      {cheatsheetOpen && <CheatsheetModal onClose={() => setCheatsheetOpen(false)} />}
    </div>
  );
}

// Keyboard shortcuts cheatsheet per WireFrames 4.18 — user-configured binds
// plus the built-in interactions that aren't rebindable.
function CheatsheetModal({ onClose }: { onClose: () => void }): ReactElement {
  const ptt = usePrefs((s) => s.pttKeybind);
  const mute = usePrefs((s) => s.muteKeybind);
  const ghost = usePrefs((s) => s.deafenKeybind);
  const share = usePrefs((s) => s.shareScreenKeybind);
  const settings = usePrefs((s) => s.openSettingsKeybind);
  const leave = usePrefs((s) => s.leaveRoomKeybind);
  const rows: Array<{ what: string; keys: string }> = [
    { what: "Push to talk (global)", keys: ptt ?? "unbound" },
    { what: "Toggle mute", keys: mute ?? "unbound" },
    { what: "Toggle ghost", keys: ghost ?? "unbound" },
    { what: "Share screen", keys: share ?? "unbound" },
    { what: "Open settings", keys: settings ?? "unbound" },
    { what: "Leave room", keys: leave ?? "unbound" },
    { what: "Send message", keys: "Enter" },
    { what: "New line in message", keys: "Shift+Enter" },
    { what: "Close menu / cancel", keys: "Esc" },
    { what: "Fullscreen a tile", keys: "double-click" },
    { what: "Focus a tile (speaker view)", keys: "click" },
    { what: "Volume / actions menu", keys: "right-click" },
  ];
  return (
    <Modal
      open={true}
      onClose={onClose}
      icon="⌨"
      title="Keyboard shortcuts"
      subtitle="Rebind the top section in Settings › Keybinds."
      width="min(92vw, 440px)"
    >
      <div style={{ padding: "var(--s-4) var(--s-6)", display: "flex", flexDirection: "column", gap: 2 }}>
        {rows.map((r) => (
          <div
            key={r.what}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-3)",
              padding: "var(--s-2) 0",
              borderBottom: "1px solid var(--border-soft)",
              fontSize: "var(--t-sm)",
            }}
          >
            <span style={{ flex: 1 }}>{r.what}</span>
            <kbd className="rv-kbd">{r.keys}</kbd>
          </div>
        ))}
      </div>
    </Modal>
  );
}

function KeybindRow({ spec }: { spec: KeybindRowSpec }): ReactElement {
  const current = usePrefs((s) => s[spec.key]);
  const [recording, setRecording] = useState(false);
  const [captured, setCaptured] = useState<string | null>(null);

  useEffect(() => {
    if (!recording) return;
    function onKey(e: KeyboardEvent): void {
      e.preventDefault();
      e.stopPropagation();
      if (["Control", "Shift", "Alt", "Meta"].includes(e.key)) return;
      if (e.key === "Escape") {
        setRecording(false);
        return;
      }
      const parts: string[] = [];
      if (e.ctrlKey) parts.push("Control");
      if (e.shiftKey) parts.push("Shift");
      if (e.altKey) parts.push("Alt");
      if (e.metaKey) parts.push("Super");
      const key = e.key === " " ? "Space" : e.key.length === 1 ? e.key.toUpperCase() : e.key;
      parts.push(key);
      setCaptured(parts.join("+"));
      setRecording(false);
    }
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [recording]);

  const persist = async (next: string | null): Promise<void> => {
    const setter = `set${spec.key.charAt(0).toUpperCase()}${spec.key.slice(1)}` as
      | "setPttKeybind"
      | "setMuteKeybind"
      | "setDeafenKeybind"
      | "setShareScreenKeybind"
      | "setOpenSettingsKeybind"
      | "setLeaveRoomKeybind";
    prefsActions()[setter](next);
    if (spec.global) {
      // PTT goes through globalShortcut in main; others stay in renderer.
      await window.r3dvoice.setPttKeybind(next);
    }
  };

  async function save(): Promise<void> {
    if (!captured) return;
    await persist(captured);
    setCaptured(null);
  }

  async function clear(): Promise<void> {
    await persist(null);
    setCaptured(null);
  }

  const display = captured ?? current ?? "none";
  const isGhost = !captured && !current;

  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        padding: "10px 0",
        borderBottom: "1px solid var(--border-soft)",
        gap: "var(--s-3)",
        flexWrap: "wrap",
      }}
    >
      <span style={{ fontSize: "var(--t-sm)", display: "inline-flex", alignItems: "baseline", gap: 6 }}>
        {spec.label}
        <span
          className="rv-mono"
          style={{ fontSize: "var(--t-2xs)", color: spec.global ? "var(--rv-amber)" : "var(--text-faint)", letterSpacing: ".08em", textTransform: "uppercase" }}
        >
          {spec.global ? "Global" : "Window"}
        </span>
      </span>
      <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
        <kbd style={isGhost ? { ...kbdStyle, color: "var(--text-faint)", fontStyle: "italic" } : kbdStyle}>
          {display}
        </kbd>
        <button
          className="rv-btn"
          data-variant="ghost"
          onClick={() => setRecording(true)}
          disabled={recording}
        >
          {recording ? "Press a key…" : "Rebind"}
        </button>
        {captured && (
          <button className="rv-btn" data-variant="primary" onClick={() => void save()}>
            Save
          </button>
        )}
        {current && !captured && (
          <button className="rv-btn" data-variant="ghost" onClick={() => void clear()}>
            Clear
          </button>
        )}
      </span>
    </div>
  );
}

function CompatTab(): ReactElement {
  const enabled = usePrefs((s) => s.compatibilityMode);

  async function toggleX11(): Promise<void> {
    const next = !enabled;
    prefsActions().setCompatibilityMode(next);
    await window.r3dvoice.setCompatibilityEnv(next);
  }

  async function relaunch(): Promise<void> {
    await window.r3dvoice.relaunch();
  }

  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-4)",
        maxWidth: 480,
      }}
    >
      <div className="rv-section-head">
        <span className="rv-label">Hardware acceleration</span>
      </div>

      {/* X11 / Wayland — wired */}
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--s-4)",
          cursor: "pointer",
          padding: "10px 0",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <div>
          <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>
            X11 compatibility mode (Linux/Wayland)
          </div>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2 }}>
            Forces Electron through XWayland. Use if screenshare glitches on Wayland. Takes effect
            after relaunch.
          </div>
        </div>
        <span
          onClick={() => void toggleX11()}
          style={{
            width: 36,
            height: 20,
            borderRadius: 999,
            background: enabled ? "var(--accent)" : "var(--bg-elev-3)",
            border:
              "1px solid " +
              (enabled
                ? "color-mix(in oklch, var(--accent) 70%, black)"
                : "var(--border-strong)"),
            position: "relative",
            transition: "all var(--d-base) var(--ease-out)",
            boxShadow: enabled
              ? "0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent)"
              : "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 1,
              left: enabled ? 17 : 1,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "var(--text)",
              transition: "left var(--d-base) var(--ease-out)",
            }}
          />
        </span>
      </label>

      {/* Inert toggles per designer */}
      <Toggle label="GPU video decode (VP9 / AV1)" defaultChecked />
      <Toggle label="Use system Picture-in-Picture" />

      <div>
        <button className="rv-btn" onClick={() => void relaunch()}>
          Relaunch app
        </button>
      </div>

      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
        Platform-specific notes:
        <ul style={{ marginTop: 4 }}>
          <li>
            <strong>macOS</strong>: grant Screen Recording permission in System Settings → Privacy
          </li>
          <li>
            <strong>Linux</strong>: system audio in screenshare needs PipeWire portal ≥ 1.14
          </li>
          <li>
            <strong>Windows</strong>: system audio uses "loopback" — no setup needed
          </li>
        </ul>
      </div>

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Permissions</span>
      </div>
      <PermissionRows />

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Privacy</span>
      </div>
      <CrashReportingRow />
    </div>
  );
}

function CrashReportingRow(): ReactElement {
  const enabled = usePrefs((s) => s.crashReporting);
  const toggle = async (): Promise<void> => {
    const next = !enabled;
    prefsActions().setCrashReporting(next);
    await window.r3dvoice.setCrashReporting(next);
  };
  return (
    <>
      <label
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          gap: "var(--s-4)",
          cursor: "pointer",
          padding: "10px 0",
          borderBottom: "1px solid var(--border-soft)",
        }}
      >
        <div>
          <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>Crash reporting</div>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2 }}>
            Local-only dumps to your user data folder. Off by default. Takes effect on next launch.
          </div>
        </div>
        <span
          onClick={() => void toggle()}
          style={{
            width: 36,
            height: 20,
            borderRadius: 999,
            background: enabled ? "var(--accent)" : "var(--bg-elev-3)",
            border:
              "1px solid " +
              (enabled
                ? "color-mix(in oklch, var(--accent) 70%, black)"
                : "var(--border-strong)"),
            position: "relative",
            transition: "all var(--d-base) var(--ease-out)",
            boxShadow: enabled
              ? "0 0 0 3px color-mix(in oklch, var(--accent) 25%, transparent)"
              : "none",
          }}
        >
          <span
            style={{
              position: "absolute",
              top: 1,
              left: enabled ? 17 : 1,
              width: 16,
              height: 16,
              borderRadius: "50%",
              background: "var(--text)",
              transition: "left var(--d-base) var(--ease-out)",
            }}
          />
        </span>
      </label>
      <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-3)" }}>
        <button
          type="button"
          className="rv-btn"
          data-variant="ghost"
          style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
          onClick={() => void window.r3dvoice.openCrashDumps()}
        >
          View dump folder
        </button>
      </div>
    </>
  );
}

function PermissionRows(): ReactElement {
  const [mic, setMic] = useState<MediaPermissionStatus>("unknown");
  const [cam, setCam] = useState<MediaPermissionStatus>("unknown");
  const [scr, setScr] = useState<MediaPermissionStatus>("unknown");
  const isMac = window.r3dvoice.platform() === "darwin";

  const refresh = async (): Promise<void> => {
    const [m, c, s] = await Promise.all([
      window.r3dvoice.getMediaPermission("microphone"),
      window.r3dvoice.getMediaPermission("camera"),
      window.r3dvoice.getMediaPermission("screen"),
    ]);
    setMic(m);
    setCam(c);
    setScr(s);
  };

  useEffect(() => {
    void refresh();
    // Re-check on focus — user may have just toggled the OS setting.
    const onFocus = (): void => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, []);

  return (
    <>
      <PermRow
        label="Microphone"
        status={mic}
        action={
          isMac && mic !== "granted" ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              style={{ height: "1.6rem", fontSize: "var(--t-xs)" }}
              onClick={() => {
                void window.r3dvoice.askMediaPermission("microphone").then(() => void refresh());
              }}
            >
              Grant
            </button>
          ) : null
        }
      />
      <PermRow
        label="Camera"
        status={cam}
        action={
          isMac && cam !== "granted" ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              style={{ height: "1.6rem", fontSize: "var(--t-xs)" }}
              onClick={() => {
                void window.r3dvoice.askMediaPermission("camera").then(() => void refresh());
              }}
            >
              Grant
            </button>
          ) : null
        }
      />
      <PermRow
        label="Screen recording"
        status={scr}
        action={
          isMac && scr !== "granted" ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              style={{ height: "1.6rem", fontSize: "var(--t-xs)" }}
              onClick={() => void window.r3dvoice.openMacScreenSettings()}
            >
              Open Settings
            </button>
          ) : null
        }
      />
    </>
  );
}

function PermRow({
  label,
  status,
  action,
}: {
  label: string;
  status: MediaPermissionStatus;
  action?: React.ReactNode;
}): ReactElement {
  const tone = status === "granted" ? "live" : status === "denied" ? "red" : "amber";
  const display =
    status === "not-determined"
      ? "not requested"
      : status === "granted"
        ? "granted"
        : status === "denied"
          ? "denied"
          : status === "restricted"
            ? "restricted"
            : "unknown";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center",
        gap: "var(--s-3)",
        padding: "10px 0",
        borderBottom: "1px solid var(--border-soft)",
      }}
    >
      <span style={{ fontSize: "var(--t-sm)" }}>{label}</span>
      <span style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
        {action}
        <span className="rv-badge" data-tone={tone}>
          {tone === "live" && <span className="pip" />}
          {display}
        </span>
      </span>
    </div>
  );
}

// Notifications & sounds per WireFrames 3.7. Sound pickers render in a
// disabled state — no sound assets are bundled in the client yet.
const SOUND_ROWS: Array<{ label: string; hint: string; options: string[] }> = [
  { label: "Mention ping", hint: "Plays when someone @mentions you.", options: ["Sonar", "Pebble", "Tap", "Off"] },
  { label: "DM received", hint: "Plays for each new DM message.", options: ["Pebble", "Sonar", "Tap", "Off"] },
  { label: "Friend joined room", hint: "When a friend joins a room you're in.", options: ["Off", "Tap", "Pebble"] },
  {
    label: "Call connect / disconnect",
    hint: "When you join or leave a room yourself.",
    options: ["Default pair", "Soft pair", "Off"],
  },
];

function NotificationsTab(): ReactElement {
  const dmBanners = usePrefs((s) => s.dmBanners);
  const dmPreviews = usePrefs((s) => s.dmPreviews);
  const roomDefault = usePrefs((s) => s.roomNotifDefault);
  const quietEnabled = usePrefs((s) => s.quietHoursEnabled);
  const quietStart = usePrefs((s) => s.quietHoursStart);
  const quietEnd = usePrefs((s) => s.quietHoursEnd);

  const roomLevels: Array<{ key: RoomNotifDefault; label: string }> = [
    { key: "all", label: "All messages" },
    { key: "mentions", label: "Mentions only" },
    { key: "none", label: "Nothing" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)", maxWidth: 480 }}>
      <div className="rv-section-head">
        <span className="rv-label">Default room behavior</span>
      </div>
      <div className="rv-seg" style={{ alignSelf: "flex-start" }}>
        {roomLevels.map((l) => (
          <button
            key={l.key}
            type="button"
            className="rv-seg-btn"
            data-active={roomDefault === l.key}
            onClick={() => prefsActions().setRoomNotifDefault(l.key)}
          >
            {l.label}
          </button>
        ))}
      </div>
      <div style={{ display: "flex", gap: "var(--s-2)", fontSize: "var(--t-xs)", color: "var(--text-dim)", lineHeight: 1.5 }}>
        <span
          className="rv-mono"
          style={{
            flex: "none",
            width: 16,
            height: 16,
            display: "inline-flex",
            alignItems: "center",
            justifyContent: "center",
            border: "1px solid var(--border)",
            borderRadius: "50%",
            fontSize: "var(--t-2xs)",
          }}
        >
          i
        </span>
        <span>
          Applied to new rooms you join. Existing rooms keep their override — change one from the
          level dropdown at the top of its chat.
        </span>
      </div>

      <div className="rv-section-head" style={{ marginTop: "var(--s-2)" }}>
        <span className="rv-label">Direct messages</span>
      </div>
      <SimpleToggle
        label="DM banners"
        hint="Show a desktop notification for every DM message."
        value={dmBanners}
        onChange={(v) => prefsActions().setDmBanners(v)}
      />
      <SimpleToggle
        label="DM previews"
        hint="Include the message text in the banner. Off if you screenshare a lot."
        value={dmPreviews}
        onChange={(v) => prefsActions().setDmPreviews(v)}
      />

      <div className="rv-section-head" style={{ marginTop: "var(--s-2)" }}>
        <span className="rv-label">Sounds</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", opacity: 0.55, pointerEvents: "none" }} aria-disabled>
        {SOUND_ROWS.map((row) => (
          <div key={row.label} style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <div>
              <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>{row.label}</div>
              <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2 }}>{row.hint}</div>
            </div>
            <div style={{ display: "flex", gap: "var(--s-2)", alignItems: "center" }}>
              <div className="rv-seg">
                {row.options.map((opt, i) => (
                  <button key={opt} type="button" className="rv-seg-btn" data-active={i === 0} tabIndex={-1}>
                    {opt}
                  </button>
                ))}
              </div>
              <button type="button" className="rv-btn rv-btn-icon" tabIndex={-1} aria-label={`Preview ${row.label}`}>
                ▶
              </button>
            </div>
          </div>
        ))}
      </div>
      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
        No notification sounds are bundled in this build yet — pickers activate when the sound pack
        ships.
      </div>

      <div className="rv-section-head" style={{ marginTop: "var(--s-2)" }}>
        <span className="rv-label">Quiet hours</span>
      </div>
      <SimpleToggle
        label="Suppress all banners + sounds during quiet hours"
        hint="Mentions still appear in the bell panel; you just don't get a popup."
        value={quietEnabled}
        onChange={(v) => prefsActions().setQuietHoursEnabled(v)}
      />
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          fontSize: "var(--t-sm)",
          color: "var(--text-mid)",
          opacity: quietEnabled ? 1 : 0.55,
        }}
      >
        <span>From</span>
        <input
          type="time"
          className="rv-input"
          style={{ width: "7.5rem" }}
          value={quietStart}
          disabled={!quietEnabled}
          onChange={(e) => prefsActions().setQuietHoursStart(e.target.value)}
        />
        <span>to</span>
        <input
          type="time"
          className="rv-input"
          style={{ width: "7.5rem" }}
          value={quietEnd}
          disabled={!quietEnabled}
          onChange={(e) => prefsActions().setQuietHoursEnd(e.target.value)}
        />
        <span style={{ color: "var(--text-dim)" }}>· local time</span>
      </div>
    </div>
  );
}

// Theme tab per WireFrames 3.6 — presets (Light/Dark/Grey/Match OS), a
// per-token hex editor with app-wide live preview, the preview card, and the
// 4.14 reset-to-preset modal (override count + export-first escape hatch).
const PRESET_LABELS: Record<ThemePreset, string> = {
  light: "Light",
  dark: "Dark",
  grey: "Grey",
  system: "Match OS",
};

function ThemeTab(): ReactElement {
  const theme = usePrefs((s) => s.theme);
  const savedOverrides = usePrefs((s) => s.themeOverrides);
  /** Preset token values with overrides lifted (what "Reset" returns to). */
  const [presetVals, setPresetVals] = useState<Record<string, string>>({});
  /** Raw hex-input texts (may be mid-edit / invalid). */
  const [texts, setTexts] = useState<Record<string, string>>({});
  /** Valid values the user applied this session (live-previewed, unsaved). */
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [resetOpen, setResetOpen] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const fileRef = useRef<HTMLInputElement | null>(null);

  // Seed/re-seed whenever the preset or the saved overrides change. rAF so
  // App's data-theme effect (parent — runs after ours) has landed first.
  useEffect(() => {
    const raf = requestAnimationFrame(() => {
      const root = document.documentElement;
      const saved = prefsActions().themeOverrides;
      for (const t of THEME_TOKENS) root.style.removeProperty(t.cssVar);
      const cs = getComputedStyle(root);
      const preset: Record<string, string> = {};
      for (const t of THEME_TOKENS) preset[t.cssVar] = cs.getPropertyValue(t.cssVar).trim();
      applyThemeOverrides(saved);
      setPresetVals(preset);
      const txt: Record<string, string> = {};
      for (const t of THEME_TOKENS) {
        txt[t.cssVar] = (saved[t.cssVar] ?? preset[t.cssVar] ?? "").toUpperCase();
      }
      setTexts(txt);
      setEdits({});
    });
    return () => cancelAnimationFrame(raf);
  }, [theme, savedOverrides]);

  // Leaving the tab without saving reverts the live preview to what's saved.
  useEffect(() => {
    return () => applyThemeOverrides(prefsActions().themeOverrides);
  }, []);

  const effectiveValue = (cssVar: string): string =>
    edits[cssVar] ?? savedOverrides[cssVar] ?? presetVals[cssVar] ?? "";

  /** Tokens that differ from the preset — what save persists / reset discards. */
  const mergedOverrides = (): Record<string, string> => {
    const out: Record<string, string> = {};
    for (const t of THEME_TOKENS) {
      const v = edits[t.cssVar] ?? savedOverrides[t.cssVar];
      if (v && v.toLowerCase() !== (presetVals[t.cssVar] ?? "").toLowerCase()) out[t.cssVar] = v;
    }
    return out;
  };
  const overrideCount = Object.keys(mergedOverrides()).length;

  const dirty = Object.entries(edits).some(
    ([k, v]) => v.toLowerCase() !== (savedOverrides[k] ?? presetVals[k] ?? "").toLowerCase(),
  );

  const onTokenText = (cssVar: string, raw: string): void => {
    setTexts((t) => ({ ...t, [cssVar]: raw }));
    const v = raw.trim();
    if (isValidHex(v)) {
      document.documentElement.style.setProperty(cssVar, v);
      setEdits((e) => ({ ...e, [cssVar]: v }));
    }
  };

  const save = (): void => {
    if (!dirty) return;
    prefsActions().setThemeOverrides(mergedOverrides());
  };

  const exportTheme = (): void => downloadThemeJson(theme, mergedOverrides());

  const onImportFile = (file: File): void => {
    void file.text().then((txt) => {
      const parsed = parseThemeJson(txt);
      if (!parsed) {
        setImportError("That file isn't a R3DVoice theme.json export.");
        return;
      }
      setImportError(null);
      const p = parsed.preset;
      if (p === "light" || p === "dark" || p === "grey" || p === "system") {
        prefsActions().setTheme(p);
      }
      prefsActions().setThemeOverrides(parsed.overrides);
    });
  };

  const presets: Array<{ key: ThemePreset; label: string; swatch: string; ink: string }> = [
    { key: "light", label: "Light", swatch: "#fafafa", ink: "#1a1a1a" },
    { key: "dark", label: "Dark", swatch: "#161616", ink: "#e6e6e6" },
    { key: "grey", label: "Grey", swatch: "#d9d9d9", ink: "#1a1a1a" },
    { key: "system", label: "Match OS", swatch: "linear-gradient(90deg, #fafafa 50%, #161616 50%)", ink: "var(--text)" },
  ];

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)", maxWidth: 480 }}>
      <div className="rv-section-head">
        <span className="rv-label">Start from preset</span>
      </div>
      <div style={{ display: "flex", gap: "var(--s-3)" }}>
        {presets.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => prefsActions().setTheme(p.key)}
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              gap: "var(--s-2)",
              padding: "var(--s-3)",
              borderRadius: "var(--r-md)",
              background: "var(--bg-elev)",
              border: theme === p.key ? "2px solid var(--accent)" : "1px solid var(--border)",
              cursor: "pointer",
              font: "inherit",
              color: "var(--text)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: "100%",
                height: "2.5rem",
                borderRadius: "var(--r-sm)",
                background: p.swatch,
                border: "1px solid var(--border-soft)",
                display: "grid",
                placeItems: "center",
                color: p.ink,
                fontWeight: 700,
              }}
            >
              Aa
            </span>
            <span style={{ fontSize: "var(--t-sm)", fontWeight: theme === p.key ? 600 : 500 }}>
              {p.label}
            </span>
          </button>
        ))}
      </div>

      <div className="rv-section-head">
        <span className="rv-label">Tokens · live preview applies app-wide</span>
      </div>
      <div style={{ display: "flex", flexDirection: "column" }}>
        {THEME_TOKENS.map((t) => {
          const text = texts[t.cssVar] ?? "";
          const invalid = text.trim() !== "" && !isValidHex(text);
          return (
            <div
              key={t.cssVar}
              style={{
                display: "grid",
                gridTemplateColumns: "auto 1fr auto",
                alignItems: "center",
                gap: "var(--s-3)",
                padding: "7px 0",
                borderBottom: "1px solid var(--border-soft)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: "var(--r-sm)",
                  border: "1px solid var(--border)",
                  background: effectiveValue(t.cssVar) || "transparent",
                  flex: "none",
                }}
              />
              <span style={{ minWidth: 0 }}>
                <span className="rv-mono" style={{ fontSize: "var(--t-sm)", display: "block" }}>
                  {t.deckName}
                </span>
                <span style={{ display: "block", fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
                  {t.desc}
                </span>
              </span>
              <input
                className="rv-input rv-mono"
                spellCheck={false}
                value={text}
                onChange={(e) => onTokenText(t.cssVar, e.target.value)}
                style={{
                  width: "6.8rem",
                  height: "1.9rem",
                  fontSize: "var(--t-xs)",
                  textTransform: "uppercase",
                  ...(invalid ? { borderColor: "var(--danger)" } : {}),
                }}
              />
            </div>
          );
        })}
      </div>

      <div className="rv-section-head">
        <span className="rv-label">Preview</span>
      </div>
      <ThemePreviewCard />

      {importError && (
        <div className="rv-err-banner" role="alert">
          <span className="ic">!</span>
          <div>{importError}</div>
        </div>
      )}

      <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-2)", flexWrap: "wrap" }}>
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <button type="button" className="rv-btn" data-variant="ghost" onClick={exportTheme}>
            Export theme.json
          </button>
          <button type="button" className="rv-btn" data-variant="ghost" onClick={() => fileRef.current?.click()}>
            Import…
          </button>
          <input
            ref={fileRef}
            type="file"
            accept=".json,application/json"
            hidden
            onChange={(e) => {
              const f = e.target.files?.[0];
              if (f) onImportFile(f);
              e.target.value = "";
            }}
          />
        </div>
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <button type="button" className="rv-btn" data-variant="danger" onClick={() => setResetOpen(true)}>
            Reset to preset
          </button>
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            data-disabled={!dirty || undefined}
            onClick={save}
          >
            Save changes
          </button>
        </div>
      </div>

      {resetOpen && (
        <ResetThemeModal
          presetLabel={PRESET_LABELS[theme]}
          overrideCount={overrideCount}
          onExport={exportTheme}
          onConfirm={() => {
            prefsActions().setThemeOverrides({});
            setResetOpen(false);
          }}
          onClose={() => setResetOpen(false)}
        />
      )}
    </div>
  );
}

// 3.6 preview card — sample UI wired to the live tokens (var() refs), so it
// repaints as the editor above applies values.
function ThemePreviewCard(): ReactElement {
  const pvBtn: CSSProperties = {
    height: "1.8rem",
    padding: "0 12px",
    borderRadius: "var(--r-sm)",
    fontSize: "var(--t-xs)",
    fontWeight: 500,
    cursor: "default",
    border: "1px solid transparent",
    background: "transparent",
  };
  const callout = (border: string, bg: string): CSSProperties => ({
    fontSize: "var(--t-2xs)",
    padding: "6px 10px",
    background: bg,
    border: `1px solid ${border}`,
    borderRadius: "var(--r-sm)",
    color: "var(--text-mid)",
  });
  const dotRow: CSSProperties = { display: "inline-flex", alignItems: "center", gap: 5 };
  const dot = (bg: string): CSSProperties => ({ width: 8, height: 8, borderRadius: "50%", background: bg });
  return (
    <div
      style={{
        background: "var(--bg)",
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        padding: "var(--s-4)",
      }}
    >
      <div
        style={{
          background: "var(--bg-elev)",
          border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-md)",
          padding: "var(--s-4)",
          display: "flex",
          flexDirection: "column",
          gap: "var(--s-3)",
        }}
      >
        {/* Row 1: speaker */}
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
          <span
            style={{
              width: 26,
              height: 26,
              borderRadius: "50%",
              background: "var(--tile-bg-2)",
              color: "#fff",
              display: "inline-flex",
              alignItems: "center",
              justifyContent: "center",
              fontSize: "var(--t-xs)",
              fontWeight: 600,
            }}
          >
            A
          </span>
          <span style={{ fontSize: "var(--t-sm)", fontWeight: 600, color: "var(--text)" }}>Alice</span>
          <span
            style={{
              fontSize: "var(--t-2xs)",
              padding: "2px 8px",
              borderRadius: "var(--r-pill)",
              background: "color-mix(in srgb, var(--danger) 10%, transparent)",
              border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
              color: "var(--danger)",
            }}
          >
            🔇 muted
          </span>
        </div>
        {/* Row 2: message w/ mention + code */}
        <span style={{ fontSize: "var(--t-sm)", color: "var(--text)", lineHeight: 1.5 }}>
          Hey{" "}
          <span style={{ background: "rgba(31,111,235,0.15)", color: "var(--text)", padding: "1px 4px", borderRadius: 3 }}>
            @bob
          </span>{" "}
          can you check the link in{" "}
          <code
            className="rv-mono"
            style={{
              fontSize: "var(--t-2xs)",
              background: "var(--bg-elev-2)",
              padding: "0 4px",
              borderRadius: 3,
              border: "1px solid var(--border-soft)",
            }}
          >
            routes.ts
          </code>
          ?
        </span>
        {/* Row 3: buttons */}
        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          <button type="button" tabIndex={-1} style={{ ...pvBtn, background: "var(--accent)", color: "var(--on-accent)", fontWeight: 600 }}>
            Primary
          </button>
          <button type="button" tabIndex={-1} style={{ ...pvBtn, background: "var(--bg-elev)", color: "var(--text)", borderColor: "var(--text)" }}>
            Secondary
          </button>
          <button type="button" tabIndex={-1} style={{ ...pvBtn, color: "var(--text-mid)", borderColor: "var(--border)" }}>
            Cancel
          </button>
          <button
            type="button"
            tabIndex={-1}
            style={{ ...pvBtn, color: "var(--danger)", borderColor: "color-mix(in srgb, var(--danger) 40%, transparent)", fontWeight: 600 }}
          >
            Delete
          </button>
        </div>
        {/* Row 4: callouts */}
        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          <span style={callout("color-mix(in srgb, var(--ok) 30%, transparent)", "color-mix(in srgb, var(--ok) 8%, transparent)")}>
            <span style={{ color: "var(--ok)", fontWeight: 700 }}>✓</span> Saved
          </span>
          <span style={callout("color-mix(in srgb, var(--rv-amber) 40%, transparent)", "color-mix(in srgb, var(--rv-amber) 8%, transparent)")}>
            <span style={{ color: "var(--rv-amber)", fontWeight: 700 }}>!</span> Quiet hours on
          </span>
        </div>
        {/* Row 5: status dots */}
        <div style={{ display: "flex", gap: 14, fontSize: "var(--t-2xs)", color: "var(--text-dim)", alignItems: "center" }}>
          <span style={dotRow}>
            <span style={dot("var(--ok)")} />
            online
          </span>
          <span style={dotRow}>
            <span style={dot("var(--rv-amber)")} />
            idle
          </span>
          <span style={dotRow}>
            <span style={dot("var(--danger)")} />
            DND
          </span>
          <span style={dotRow}>
            <span style={{ width: 8, height: 8, borderRadius: "50%", border: "1.5px solid var(--text-dim)" }} />
            offline
          </span>
        </div>
      </div>
    </div>
  );
}

// 4.14 — reset theme to defaults: shows what gets discarded (override count),
// offers the export escape hatch, then clears the override map.
function ResetThemeModal({
  presetLabel,
  overrideCount,
  onExport,
  onConfirm,
  onClose,
}: {
  presetLabel: string;
  overrideCount: number;
  onExport: () => void;
  onConfirm: () => void;
  onClose: () => void;
}): ReactElement {
  const chip: CSSProperties = {
    display: "flex",
    flexDirection: "column",
    gap: 4,
    padding: "var(--s-3) var(--s-4)",
    background: "var(--bg-elev-2)",
    border: "1px solid var(--border-soft)",
    borderRadius: "var(--r-md)",
    flex: 1,
    minWidth: 0,
  };
  return (
    <Modal
      open={true}
      onClose={onClose}
      icon="↺"
      title="Reset theme to defaults?"
      subtitle="Your token edits will be replaced by the preset."
      width="min(92vw, 440px)"
      footer={
        <div style={{ display: "flex", justifyContent: "space-between", gap: "var(--s-2)", width: "100%" }}>
          <button type="button" className="rv-btn" data-variant="ghost" onClick={onExport}>
            ↓ Export theme.json
          </button>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="rv-btn" data-variant="danger" onClick={onConfirm}>
              Reset
            </button>
          </div>
        </div>
      }
    >
      <div style={{ padding: "var(--s-4) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
        <p style={{ margin: 0, fontSize: "var(--t-sm)", color: "var(--text-mid)", lineHeight: 1.5 }}>
          The current theme will be replaced with the {presetLabel} preset's tokens. Anything
          you've customized goes back to default.
        </p>
        <div style={{ display: "flex", gap: "var(--s-3)" }}>
          <div style={chip}>
            <span className="rv-label">Current</span>
            <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>
              {overrideCount === 0 ? "No overrides" : `Custom (${overrideCount} override${overrideCount === 1 ? "" : "s"})`}
            </span>
          </div>
          <div style={chip}>
            <span className="rv-label">Reset to</span>
            <span style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>{presetLabel}</span>
          </div>
        </div>
        <div
          style={{
            display: "flex",
            gap: "var(--s-2)",
            padding: "var(--s-3)",
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-md)",
            fontSize: "var(--t-xs)",
            color: "var(--text-mid)",
            lineHeight: 1.5,
          }}
        >
          <span aria-hidden style={{ flex: "none" }}>↓</span>
          <span>
            Export your current theme.json first if you want to keep it. You can re-import it
            anytime.
          </span>
        </div>
      </div>
    </Modal>
  );
}

function AccountTab({ onClose }: { onClose: () => void }): ReactElement {
  const user = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const logout = useAuthStore((s) => s.logout);
  const updateAvatarUrl = useAuthStore((s) => s.updateAvatarUrl);
  const [confirming, setConfirming] = useState(false);
  const [avatarUrlDraft, setAvatarUrlDraft] = useState(user?.avatarUrl ?? "");
  const [avatarBusy, setAvatarBusy] = useState(false);
  const [avatarError, setAvatarError] = useState<string | null>(null);

  useEffect(() => {
    setAvatarUrlDraft(user?.avatarUrl ?? "");
  }, [user?.avatarUrl]);

  const handleSwitch = async (): Promise<void> => {
    await logout();
    onClose();
  };

  const totpEnabled = user?.totpEnabled === true;

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)", maxWidth: 480 }}>
      <div className="rv-section-head">
        <span className="rv-label">Signed in</span>
      </div>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--s-3)",
          padding: "var(--s-3) var(--s-4)",
          background: "var(--bg-elev-2)",
          border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-md)",
        }}
      >
        <Avatar
          src={user?.avatarUrl ?? null}
          fallbackInitials={user?.displayName ?? ""}
          fallbackColorSeed={user?.id ?? ""}
          size={48}
        />
        <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
          <span style={{ fontWeight: 500 }}>{user?.displayName ?? "(unknown)"}</span>
          <span
            className="rv-mono"
            style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", overflow: "hidden", textOverflow: "ellipsis" }}
          >
            {user?.email ?? ""}
          </span>
        </div>
      </div>

      <ProfileIdentityFields />

      <div className="rv-field">
        <label className="rv-label">Profile picture URL</label>
        <input
          className="rv-input"
          type="url"
          placeholder="https://…"
          value={avatarUrlDraft}
          onChange={(e) => setAvatarUrlDraft(e.target.value)}
          disabled={avatarBusy}
        />
        <div style={{ display: "flex", gap: "var(--s-2)", marginTop: "var(--s-2)", alignItems: "center" }}>
          <Avatar
            src={avatarUrlDraft.trim() || null}
            fallbackInitials={user?.displayName ?? ""}
            fallbackColorSeed={user?.id ?? ""}
            size={48}
          />
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            disabled={avatarBusy || avatarUrlDraft === (user?.avatarUrl ?? "")}
            onClick={async () => {
              setAvatarBusy(true);
              setAvatarError(null);
              try {
                const next = avatarUrlDraft.trim();
                await updateAvatarUrl(next === "" ? null : next);
              } catch (e) {
                setAvatarError(e instanceof Error ? e.message : "failed to save");
              } finally {
                setAvatarBusy(false);
              }
            }}
          >
            Save
          </button>
          {(user?.avatarUrl ?? null) !== null && (
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              disabled={avatarBusy}
              onClick={async () => {
                setAvatarBusy(true);
                try { await updateAvatarUrl(null); setAvatarUrlDraft(""); }
                finally { setAvatarBusy(false); }
              }}
            >
              Remove
            </button>
          )}
        </div>
        {avatarError && <div style={{ color: "var(--accent)", fontSize: "var(--t-sm)", marginTop: "var(--s-1)" }}>{avatarError}</div>}
        <div className="rv-field-help">Paste a direct image URL (https only). Falls back to your initials if missing or broken.</div>
      </div>

      <div className="rv-section-head">
        <span className="rv-label">Server</span>
      </div>
      <div
        style={{
          padding: "var(--s-3) var(--s-4)",
          background: "var(--bg-elev-2)",
          border: "1px solid var(--border-soft)",
          borderRadius: "var(--r-md)",
          display: "flex",
          flexDirection: "column",
          gap: 4,
        }}
      >
        <span className="rv-mono" style={{ fontSize: "var(--t-sm)", wordBreak: "break-all" }}>
          {serverUrl}
        </span>
        <span style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)" }}>
          Self-hosted instance
        </span>
      </div>

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Two-factor auth</span>
      </div>
      <TwoFactorSection enabled={totpEnabled} />

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Encryption key backup</span>
      </div>
      <E2eeKeySection onSignedOut={() => void handleSwitch()} />

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Actions</span>
      </div>
      {!confirming ? (
        <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
          <button type="button" className="rv-btn" onClick={() => setConfirming(true)}>
            Switch server
          </button>
          <button type="button" className="rv-btn" data-variant="ghost" onClick={() => void handleSwitch()}>
            Sign out
          </button>
        </div>
      ) : (
        <div
          style={{
            padding: "var(--s-4)",
            background: "color-mix(in oklch, var(--accent) 8%, var(--bg-elev-2))",
            border: "1px solid color-mix(in oklch, var(--accent) 35%, var(--border))",
            borderRadius: "var(--r-md)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--s-3)",
          }}
        >
          <div style={{ fontSize: "var(--t-sm)", color: "var(--text)", lineHeight: 1.5 }}>
            Switching servers signs you out on this device and returns to the login screen so you
            can change the Server URL. Your account on{" "}
            <span className="rv-mono">{serverUrl}</span> is unaffected.
          </div>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              onClick={() => void handleSwitch()}
            >
              Sign out + switch
            </button>
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              onClick={() => setConfirming(false)}
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Sessions</span>
      </div>
      <SessionsSection onSignedOutEverywhere={() => void handleSwitch()} />

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Blocked users</span>
      </div>
      <BlockedUsersSection />

      <div className="rv-section-head" style={{ marginTop: "var(--s-3)" }}>
        <span className="rv-label">Danger zone</span>
      </div>
      <DeleteAccountSection onDeleted={() => void handleSwitch()} />
    </div>
  );
}

// 4.11 — active sessions + sign out everywhere.
function SessionsSection({ onSignedOutEverywhere }: { onSignedOutEverywhere: () => void }): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [count, setCount] = useState<number | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    api
      .listSessions()
      .then((r) => {
        if (!cancelled) setCount(r.sessions.length);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [serverUrl, token]);

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
      <div style={{ fontSize: "var(--t-sm)", color: "var(--text-mid)" }}>
        {count === null ? "…" : `${count} active session${count === 1 ? "" : "s"}`} — signing out
        everywhere revokes all of them, including this one.
      </div>
      {!confirming ? (
        <div>
          <button type="button" className="rv-btn" data-variant="danger" onClick={() => setConfirming(true)}>
            Sign out everywhere
          </button>
        </div>
      ) : (
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <button
            type="button"
            className="rv-btn"
            data-variant="danger"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              const api = new ApiClient(serverUrl);
              api.setToken(token);
              void api
                .logoutAll()
                .then(() => onSignedOutEverywhere())
                .finally(() => setBusy(false));
            }}
          >
            {busy ? "Signing out…" : "Yes, everywhere"}
          </button>
          <button type="button" className="rv-btn" data-variant="ghost" onClick={() => setConfirming(false)}>
            Cancel
          </button>
        </div>
      )}
    </div>
  );
}

// 3.3a — blocked users list with unblock.
function BlockedUsersSection(): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [blocked, setBlocked] = useState<Array<{ friendshipId: string; name: string; handle: string | null }>>([]);
  const [loaded, setLoaded] = useState(false);

  const refresh = (): void => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    void api
      .friends()
      .then((r) => {
        setBlocked(
          r.friends
            .filter((f) => f.status === "blocked")
            .map((f) => ({ friendshipId: f.friendshipId, name: f.user.displayName, handle: f.user.handle ?? null })),
        );
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
  };

  useEffect(refresh, [serverUrl, token]);

  if (!loaded) return <div className="rv-skeleton" style={{ height: "2rem" }} />;
  if (blocked.length === 0) {
    return <div style={{ fontSize: "var(--t-sm)", color: "var(--text-dim)" }}>Nobody blocked.</div>;
  }
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
      {blocked.map((b) => (
        <div key={b.friendshipId} style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", fontSize: "var(--t-sm)" }}>
          <span style={{ flex: 1 }}>
            {b.name}
            {b.handle && <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}> @{b.handle}</span>}
          </span>
          <button
            className="rv-btn"
            style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
            onClick={() => {
              const api = new ApiClient(serverUrl);
              api.setToken(token);
              void api.unblockFriend(b.friendshipId).then(refresh);
            }}
          >
            Unblock
          </button>
        </div>
      ))}
    </div>
  );
}

// 4.12 — delete account: type-handle confirm (UX) + password re-auth (security).
function DeleteAccountSection({ onDeleted }: { onDeleted: () => void }): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const [open, setOpen] = useState(false);
  const [confirmText, setConfirmText] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const expected = user?.handle ?? user?.displayName ?? "";
  const matches = confirmText === expected && password.length > 0;

  if (!open) {
    return (
      <div>
        <button type="button" className="rv-btn" data-variant="danger" onClick={() => setOpen(true)}>
          Delete account…
        </button>
      </div>
    );
  }
  return (
    <div
      style={{
        padding: "var(--s-4)",
        background: "color-mix(in srgb, var(--danger) 6%, transparent)",
        border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
        borderRadius: "var(--r-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
      }}
    >
      <div style={{ fontSize: "var(--t-sm)", lineHeight: 1.5 }}>
        Deleting your account removes your profile, sessions, friendships, and every room you
        own (disconnecting their members). DM messages you sent stay for the other person.
        <b style={{ fontWeight: 600 }}> There is no undo.</b>
      </div>
      <Field label={`Type ${expected} to confirm`}>
        <input className="rv-input" value={confirmText} spellCheck={false} onChange={(e) => setConfirmText(e.target.value)} />
      </Field>
      <Field label="Your password">
        <input className="rv-input" type="password" value={password} onChange={(e) => setPassword(e.target.value)} />
      </Field>
      {error && (
        <div className="rv-err-banner" role="alert">
          <span className="ic">!</span>
          <div>{error}</div>
        </div>
      )}
      <div style={{ display: "flex", gap: "var(--s-2)" }}>
        <button type="button" className="rv-btn" data-variant="ghost" onClick={() => setOpen(false)}>
          Cancel
        </button>
        <button
          type="button"
          className="rv-btn"
          data-variant="danger"
          data-disabled={!matches || busy || undefined}
          onClick={() => {
            if (!matches || busy) return;
            setBusy(true);
            setError(null);
            const api = new ApiClient(serverUrl);
            api.setToken(token);
            void api
              .deleteAccount(password)
              .then(() => onDeleted())
              .catch((e: unknown) => {
                setError(e instanceof Error ? e.message : "failed");
                setBusy(false);
              });
          }}
        >
          {busy ? "Deleting…" : "Delete my account forever"}
        </button>
      </div>
    </div>
  );
}

// Display name + handle editing per 3.3 Profile section. The deck's gate
// copy promises "change it anytime from Settings › Account" — this is that.
function ProfileIdentityFields(): ReactElement {
  const user = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const refreshUser = useAuthStore((s) => s.refreshUser);

  const [nameDraft, setNameDraft] = useState(user?.displayName ?? "");
  const [handleDraft, setHandleDraft] = useState(user?.handle ?? "");
  const [busy, setBusy] = useState<"name" | "handle" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<"name" | "handle" | null>(null);

  useEffect(() => setNameDraft(user?.displayName ?? ""), [user?.displayName]);
  useEffect(() => setHandleDraft(user?.handle ?? ""), [user?.handle]);

  const api = (): ApiClient => {
    const a = new ApiClient(serverUrl);
    a.setToken(token);
    return a;
  };

  const saveName = async (): Promise<void> => {
    setBusy("name");
    setError(null);
    try {
      await api().updateMe({ displayName: nameDraft.trim() });
      await refreshUser();
      setSaved("name");
      setTimeout(() => setSaved(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setBusy(null);
    }
  };

  const saveHandle = async (): Promise<void> => {
    setBusy("handle");
    setError(null);
    try {
      await api().setMyHandle(handleDraft.trim());
      await refreshUser();
      setSaved("handle");
      setTimeout(() => setSaved(null), 1500);
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setBusy(null);
    }
  };

  return (
    <>
      <div className="rv-field">
        <label className="rv-label">Display name</label>
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <input
            className="rv-input"
            maxLength={50}
            value={nameDraft}
            onChange={(e) => setNameDraft(e.target.value)}
            disabled={busy !== null}
          />
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            disabled={busy !== null || !nameDraft.trim() || nameDraft.trim() === user?.displayName}
            onClick={() => void saveName()}
          >
            {busy === "name" ? "Saving…" : saved === "name" ? "Saved ✓" : "Save"}
          </button>
        </div>
      </div>

      <div className="rv-field">
        <label className="rv-label">Handle</label>
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          <div
            style={{
              flex: 1,
              display: "flex",
              alignItems: "center",
              height: "2.5rem",
              padding: "0 var(--s-3)",
              border: "1px solid var(--border)",
              borderRadius: "var(--r-md)",
              background: "var(--bg-elev-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-sm)",
            }}
          >
            <span style={{ color: "var(--text-dim)", marginRight: 1 }}>@</span>
            <input
              value={handleDraft}
              onChange={(e) => setHandleDraft(e.target.value)}
              disabled={busy !== null}
              spellCheck={false}
              style={{ flex: 1, minWidth: 0, border: 0, outline: "none", background: "transparent", font: "inherit", color: "var(--text)" }}
            />
          </div>
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            disabled={busy !== null || !handleDraft.trim() || handleDraft.trim() === user?.handle}
            onClick={() => void saveHandle()}
          >
            {busy === "handle" ? "Saving…" : saved === "handle" ? "Saved ✓" : "Save"}
          </button>
        </div>
        <div className="rv-field-help">Used for @mentions. 3–24 characters: letters, digits, underscores.</div>
      </div>

      {error && (
        <div className="rv-err-banner" role="alert">
          <span className="ic">!</span>
          <div>{error}</div>
        </div>
      )}
    </>
  );
}

function E2eeKeySection({ onSignedOut }: { onSignedOut: () => void }): ReactElement {
  const user = useAuthStore((s) => s.user);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const kp = loadKeyPair();
  const handleExport = (): void => {
    if (!kp || !user) return;
    downloadKeyBackup(user.email, kp);
  };
  const clearAndSignOut = (): void => {
    clearKeyPair();
    onSignedOut();
  };
  return (
    <div
      style={{
        padding: "var(--s-4)",
        background: "var(--bg-elev-2)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
      }}
    >
      <div>
        <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>
          DM encryption keypair
        </div>
        <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2, lineHeight: 1.5 }}>
          {kp
            ? "Save this file somewhere safe. You'll need it to read your DM history on a new device. Losing it = losing the history (no recovery — that's the point of zero-trust)."
            : "No keypair on this device. Sign out and sign in again to generate one, or restore from a previous backup at login."}
        </div>
      </div>
      <div style={{ display: "flex", gap: "var(--s-2)", flexWrap: "wrap" }}>
        <button
          type="button"
          className="rv-btn"
          data-variant={kp ? "primary" : "ghost"}
          disabled={!kp}
          onClick={handleExport}
        >
          <I.Copy size={14} /> Download key backup
        </button>
        {kp && !confirmingClear && (
          <button
            type="button"
            className="rv-btn"
            data-variant="danger"
            onClick={() => setConfirmingClear(true)}
          >
            Sign out &amp; clear keys on this device…
          </button>
        )}
      </div>
      {confirmingClear && (
        <div
          style={{
            padding: "var(--s-3)",
            background: "color-mix(in srgb, var(--danger) 6%, transparent)",
            border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
            borderRadius: "var(--r-sm)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--s-3)",
          }}
        >
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", lineHeight: 1.5 }}>
            This deletes the E2EE keypair stored on this device, then signs you out. Without a key
            backup, your encrypted DM history becomes unreadable here — download the backup above
            first if you might want it back.
          </div>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button type="button" className="rv-btn" data-variant="danger" onClick={clearAndSignOut}>
              Clear keys + sign out
            </button>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={() => setConfirmingClear(false)}>
              Cancel
            </button>
          </div>
        </div>
      )}
    </div>
  );
}


function TwoFactorSection({ enabled }: { enabled: boolean }): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const refreshUser = useAuthStore((s) => s.refreshUser);

  const [phase, setPhase] = useState<"idle" | "enrolling" | "disabling">("idle");
  const [qrDataUrl, setQrDataUrl] = useState<string | null>(null);
  const [secret, setSecret] = useState<string | null>(null);
  const [backupCodes, setBackupCodes] = useState<string[] | null>(null);
  const [regenPw, setRegenPw] = useState<string | null>(null); // null = closed
  const [code, setCode] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const apiFor = (): ApiClient => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  };

  const startEnroll = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFor().twoFAEnrollStart();
      setSecret(res.secret);
      setQrDataUrl(res.qrDataUrl);
      setPhase("enrolling");
    } catch (err) {
      setError(err instanceof Error ? err.message : "failed to start enrollment");
    } finally {
      setBusy(false);
    }
  };

  const verifyEnroll = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const res = await apiFor().twoFAEnrollVerify(code);
      await refreshUser();
      setPhase("idle");
      setQrDataUrl(null);
      setSecret(null);
      setCode("");
      if (res.backupCodes) setBackupCodes(res.backupCodes);
    } catch (err) {
      setError(err instanceof Error ? err.message : "verification failed");
    } finally {
      setBusy(false);
    }
  };

  const startDisable = (): void => {
    setPhase("disabling");
    setError(null);
  };

  const confirmDisable = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiFor().twoFADisable(password);
      await refreshUser();
      setPhase("idle");
      setPassword("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "disable failed");
    } finally {
      setBusy(false);
    }
  };

  const cancel = (): void => {
    setPhase("idle");
    setQrDataUrl(null);
    setSecret(null);
    setCode("");
    setPassword("");
    setError(null);
  };

  return (
    <div
      style={{
        padding: "var(--s-4)",
        background: "var(--bg-elev-2)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-md)",
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-3)",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
        <div>
          <div style={{ fontSize: "var(--t-sm)", fontWeight: 500 }}>
            Authenticator app (TOTP)
          </div>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: 2 }}>
            {enabled
              ? "Enabled. You'll be asked for a code on each sign-in."
              : "Off. Add a layer with Google Authenticator, Authy, 1Password, etc."}
          </div>
        </div>
        <span className="rv-badge" data-tone={enabled ? "live" : undefined}>
          {enabled && <span className="pip" />}
          {enabled ? "enabled" : "disabled"}
        </span>
      </div>

      {phase === "idle" && (
        <div style={{ display: "flex", gap: "var(--s-2)" }}>
          {!enabled ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              onClick={() => void startEnroll()}
              disabled={busy}
            >
              Enable 2FA
            </button>
          ) : (
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              onClick={startDisable}
            >
              Disable 2FA
            </button>
          )}
        </div>
      )}

      {phase === "enrolling" && qrDataUrl && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", lineHeight: 1.5 }}>
            Scan this QR with your authenticator app, then enter the 6-digit code below to confirm.
          </div>
          <div style={{ display: "flex", gap: "var(--s-3)", alignItems: "flex-start" }}>
            <img
              src={qrDataUrl}
              alt="2FA QR code"
              style={{
                width: 160,
                height: 160,
                background: "white",
                borderRadius: "var(--r-sm)",
                border: "1px solid var(--border)",
              }}
            />
            <div style={{ display: "flex", flexDirection: "column", gap: 6, flex: 1, minWidth: 0 }}>
              <span className="rv-label">Or enter manually</span>
              <code
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-xs)",
                  padding: "6px 8px",
                  background: "var(--bg-elev-3)",
                  borderRadius: 4,
                  wordBreak: "break-all",
                  color: "var(--text)",
                }}
              >
                {secret}
              </code>
            </div>
          </div>
          <input
            className="rv-input"
            type="text"
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/[^\d]/g, ""))}
            placeholder="123456"
            style={{ fontFamily: "var(--font-mono)", letterSpacing: "0.4em", textAlign: "center" }}
          />
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              disabled={busy || code.length !== 6}
              onClick={() => void verifyEnroll()}
            >
              Verify + enable
            </button>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {phase === "disabling" && (
        <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", lineHeight: 1.5 }}>
            Confirm with your password to disable 2FA on this account.
          </div>
          <input
            className="rv-input"
            type="password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            placeholder="Current password"
          />
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              disabled={busy || !password}
              onClick={() => void confirmDisable()}
            >
              Confirm disable
            </button>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={cancel}>
              Cancel
            </button>
          </div>
        </div>
      )}

      {error && (
        <div
          style={{
            color: "var(--accent-glow)",
            fontSize: "var(--t-xs)",
            padding: "var(--s-2) var(--s-3)",
            border: "1px solid color-mix(in oklch, var(--accent) 40%, transparent)",
            borderRadius: "var(--r-sm)",
            background: "color-mix(in oklch, var(--accent) 8%, var(--bg-elev-2))",
          }}
        >
          {error}
        </div>
      )}
          {backupCodes && (
        <div
          style={{
            padding: "var(--s-3)",
            background: "color-mix(in srgb, var(--rv-amber) 8%, transparent)",
            border: "1px solid color-mix(in srgb, var(--rv-amber) 40%, transparent)",
            borderRadius: "var(--r-sm)",
            display: "flex",
            flexDirection: "column",
            gap: "var(--s-2)",
          }}
        >
          <div style={{ fontSize: "var(--t-sm)", fontWeight: 600 }}>
            Backup codes — shown once, save them now
          </div>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)", lineHeight: 1.5 }}>
            Each signs you in exactly once if you lose your authenticator.
          </div>
          <div
            className="rv-mono"
            style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 4, fontSize: "var(--t-xs)" }}
          >
            {backupCodes.map((c) => (
              <span key={c}>{c}</span>
            ))}
          </div>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button
              className="rv-btn"
              style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
              onClick={() => void navigator.clipboard.writeText(backupCodes.join("\n")).catch(() => {})}
            >
              Copy all
            </button>
            <button
              className="rv-btn"
              data-variant="ghost"
              style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
              onClick={() => setBackupCodes(null)}
            >
              I saved them
            </button>
          </div>
        </div>
      )}
      {enabled && !backupCodes && (
        <div>
          {regenPw === null ? (
            <button
              className="rv-btn"
              style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
              onClick={() => setRegenPw("")}
            >
              Regenerate backup codes
            </button>
          ) : (
            <div style={{ display: "flex", gap: "var(--s-2)" }}>
              <input
                className="rv-input"
                type="password"
                placeholder="Password"
                value={regenPw}
                onChange={(e) => setRegenPw(e.target.value)}
                style={{ height: "1.7rem", fontSize: "var(--t-xs)" }}
              />
              <button
                className="rv-btn"
                data-variant="primary"
                style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
                disabled={!regenPw}
                onClick={() => {
                  void apiFor()
                    .regenerateBackupCodes(regenPw)
                    .then((r) => {
                      setBackupCodes(r.backupCodes);
                      setRegenPw(null);
                    })
                    .catch((e: unknown) => setError(e instanceof Error ? e.message : "failed"));
                }}
              >
                Generate
              </button>
              <button
                className="rv-btn"
                data-variant="ghost"
                style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
                onClick={() => setRegenPw(null)}
              >
                Cancel
              </button>
            </div>
          )}
        </div>
      )}
      </div>
  );
}

function AboutTab(): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        flexDirection: "column",
        gap: "var(--s-5)",
        maxWidth: 460,
      }}
    >
      <div style={{ display: "flex", gap: "var(--s-4)", alignItems: "center" }}>
        <I.Logo size={48} />
        <div>
          <div style={{ fontSize: "var(--t-xl)", fontWeight: 700, letterSpacing: "-0.01em" }}>
            R3DVoice
          </div>
          <div className="rv-mono" style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
            v{APP_VERSION} · electron 35 · chromium 130
          </div>
        </div>
      </div>
      <p style={{ color: "var(--text-mid)", lineHeight: 1.6, margin: 0 }}>
        Open-source voice + screenshare. Self-host the server, own your data, keep your raid in
        your basement. MIT licensed, no telemetry by default.
      </p>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(2,1fr)",
          gap: "var(--s-2)",
        }}
      >
        <a
          className="rv-btn"
          href="https://github.com/R3dWolfie/R3DVoice"
          target="_blank"
          rel="noreferrer"
        >
          View on GitHub
        </a>
        <a
          className="rv-btn"
          href="https://github.com/R3dWolfie/R3DVoice/issues/new"
          target="_blank"
          rel="noreferrer"
        >
          Report an issue
        </a>
        <a
          className="rv-btn"
          href="https://github.com/R3dWolfie/R3DVoice/releases"
          target="_blank"
          rel="noreferrer"
          style={{ gridColumn: "span 2" }}
        >
          What's new — release notes
        </a>
      </div>
    </div>
  );
}
