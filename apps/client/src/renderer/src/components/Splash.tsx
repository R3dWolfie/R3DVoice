import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { I } from "./Icons.js";
import type { SplashStatus, SplashPhase } from "../../../shared/bridge-types.js";

const PHASE_LABEL: Record<SplashPhase, string> = {
  initializing: "Initializing…",
  checking: "Checking for updates…",
  available: "Update available — downloading",
  downloading: "Downloading update",
  downloaded: "Update downloaded — restarting",
  loading: "Loading…",
  ready: "Ready",
  error: "Couldn’t check for updates",
};

function statusMessage(status: SplashStatus): string {
  if (status.message) return status.message;
  if (status.phase === "downloading" && typeof status.percent === "number") {
    return `Downloading update — ${Math.round(status.percent)}%`;
  }
  return PHASE_LABEL[status.phase];
}

const wrapStyle: CSSProperties = {
  position: "fixed",
  inset: 0,
  display: "grid",
  placeItems: "center",
  background: "var(--bg)",
  color: "var(--text)",
  overflow: "hidden",
  isolation: "isolate",
  WebkitUserSelect: "none",
  userSelect: "none",
  // Window itself is frameless; let the entire surface drag the window so
  // it can be repositioned (matters on multi-monitor setups where the
  // splash spawns on the wrong screen).
  WebkitAppRegion: "drag",
} as CSSProperties;

const vignetteStyle: CSSProperties = {
  position: "absolute",
  inset: 0,
  pointerEvents: "none",
  background:
    "radial-gradient(120% 90% at 18% 12%, color-mix(in oklch, var(--rv-red-600) 22%, transparent) 0%, transparent 55%), " +
    "radial-gradient(80% 70% at 100% 100%, color-mix(in oklch, var(--rv-red-900) 30%, transparent) 0%, transparent 55%)",
};

const contentStyle: CSSProperties = {
  position: "relative",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--s-5)",
  padding: "var(--s-6)",
  textAlign: "center",
  zIndex: 1,
};

const titleStyle: CSSProperties = {
  fontFamily: "var(--font-ui)",
  fontSize: "var(--t-2xl)",
  fontWeight: 700,
  letterSpacing: "-0.01em",
  lineHeight: 1.05,
  margin: 0,
};

const statusStyle: CSSProperties = {
  fontSize: "var(--t-sm)",
  color: "var(--text-mid)",
  minHeight: "1.4em",
  letterSpacing: ".01em",
};

const progressWrapStyle: CSSProperties = {
  width: "240px",
  marginTop: "var(--s-2)",
};

export function Splash(): ReactElement {
  const [status, setStatus] = useState<SplashStatus>({ phase: "initializing" });

  useEffect(() => {
    const off = window.r3dvoice.onSplashStatus((next) => setStatus(next));
    return off;
  }, []);

  const showProgress = status.phase === "downloading" && typeof status.percent === "number";
  const progressPct = showProgress ? Math.max(0, Math.min(100, status.percent ?? 0)) : 0;

  return (
    <div style={wrapStyle} className="rv-fade-in">
      <div style={vignetteStyle} aria-hidden />
      <div style={contentStyle}>
        <I.Logo size={96} />
        <h1 style={titleStyle}>R3DVoice</h1>
        <div style={statusStyle} aria-live="polite">
          {statusMessage(status)}
        </div>
        {showProgress ? (
          <div style={progressWrapStyle}>
            <div className="rv-vu" role="progressbar" aria-valuenow={progressPct} aria-valuemin={0} aria-valuemax={100}>
              <div className="rv-vu-fill" style={{ width: `${progressPct}%` }} />
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
