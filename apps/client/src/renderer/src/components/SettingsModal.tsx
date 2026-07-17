import {
  useEffect,
  useState,
  type CSSProperties,
  type ReactElement,
  type ReactNode,
} from "react";
import { listAudioInputs, listAudioOutputs, type DeviceInfo } from "../lib/media.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import type { MediaPermissionStatus } from "../../../shared/bridge-types.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { downloadKeyBackup, loadKeyPair } from "../lib/key-storage.js";
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
        <span className="rv-label">Audio In/Out</span>
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
      <Field label="Speakers">
        <select
          className="rv-select"
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
        Changes apply live — no need to rejoin.
      </div>

      <div className="rv-section-head">
        <span className="rv-label">Processing</span>
      </div>
      <ProcessingControls />
      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)", marginTop: "var(--s-2)" }}>
        Changes apply on the next mic open (rejoin or PTT cycle).
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

const KEYBIND_ROWS: KeybindRowSpec[] = [
  { label: "Push to talk", key: "pttKeybind", global: true },
  { label: "Toggle mute", key: "muteKeybind", global: false },
  { label: "Toggle ghost", key: "deafenKeybind", global: false },
  { label: "Toggle screen-share", key: "shareScreenKeybind", global: false },
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

  const display = captured ?? current ?? "(none)";

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
        <kbd style={kbdStyle}>{display}</kbd>
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

// Notifications tab per WireFrames 3.7 (honest subset): DM banner + preview
// toggles feed notification-router; per-thread levels live on each thread's
// header. Sound pickers land with the chat-extras pass.
function NotificationsTab(): ReactElement {
  const dmBanners = usePrefs((s) => s.dmBanners);
  const dmPreviews = usePrefs((s) => s.dmPreviews);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)", maxWidth: 480 }}>
      <div className="rv-section-head">
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
        hint="Include the message text in the banner. Turn off if you screenshare a lot."
        value={dmPreviews}
        onChange={(v) => prefsActions().setDmPreviews(v)}
      />
      <div className="rv-section-head" style={{ marginTop: "var(--s-2)" }}>
        <span className="rv-label">Per-room levels</span>
      </div>
      <p style={{ margin: 0, fontSize: "var(--t-xs)", color: "var(--text-dim)", lineHeight: 1.5 }}>
        Each room and DM has its own level (all · @mentions only · muted) in the dropdown at the
        top of its chat. Do-Not-Disturb silences everything except friend requests.
      </p>
    </div>
  );
}

// Theme tab per WireFrames 3.6 — preset picker. The deck also specs a
// per-token hex editor with live preview; that ships once presets have
// settled (tracked with the polish backlog).
function ThemeTab(): ReactElement {
  const theme = usePrefs((s) => s.theme);
  const presets = [
    { key: "light" as const, label: "Light", swatch: "#fafafa", ink: "#1a1a1a" },
    { key: "dark" as const, label: "Dark", swatch: "#161616", ink: "#e6e6e6" },
    { key: "system" as const, label: "Match OS", swatch: "linear-gradient(90deg, #fafafa 50%, #161616 50%)", ink: "var(--text)" },
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
              padding: "var(--s-4)",
              borderRadius: "var(--r-md)",
              background: "var(--bg-elev)",
              border:
                theme === p.key
                  ? "2px solid var(--accent)"
                  : "1px solid var(--border)",
              cursor: "pointer",
              font: "inherit",
              color: "var(--text)",
            }}
          >
            <span
              aria-hidden
              style={{
                width: "100%",
                height: "3rem",
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
      <p style={{ margin: 0, fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
        Applies instantly, everywhere. Custom token editing (per-color tweaks with live
        preview) is planned — the stylesheet is already token-driven.
      </p>
      {/* 4.14 — with presets, reset = back to the deck default */}
      <div>
        <button
          type="button"
          className="rv-btn"
          data-variant="danger"
          data-disabled={theme === "light" || undefined}
          onClick={() => {
            if (theme !== "light") prefsActions().setTheme("light");
          }}
        >
          Reset theme to defaults
        </button>
      </div>
    </div>
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
      <E2eeKeySection />

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

function E2eeKeySection(): ReactElement {
  const user = useAuthStore((s) => s.user);
  const kp = loadKeyPair();
  const handleExport = (): void => {
    if (!kp || !user) return;
    downloadKeyBackup(user.email, kp);
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
      <div>
        <button
          type="button"
          className="rv-btn"
          data-variant={kp ? "primary" : "ghost"}
          disabled={!kp}
          onClick={handleExport}
        >
          <I.Copy size={14} /> Download key backup
        </button>
      </div>
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
      await apiFor().twoFAEnrollVerify(code);
      await refreshUser();
      setPhase("idle");
      setQrDataUrl(null);
      setSecret(null);
      setCode("");
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
