import { useEffect, useState, type ReactElement } from "react";
import { readUxMetrics, readCallStats, type UxMetrics, type CallStats } from "../lib/telemetry.js";

// Live UX + call-quality HUD. Toggle with Ctrl+Shift+D (or Settings › Advanced).
// Turns "it feels laggy / buttons are unresponsive" into numbers you can read
// on any device — especially a friend's, where the experience is bad.
//
// How to read it:
//   INP    = ms from a click to the UI updating. <200 good · 200-500 sluggish
//            · >500 the "buttons are dead" feeling.
//   BLOCK  = ms/s the main thread was frozen. High = clicks/scroll stutter.
//   FPS    = render smoothness. <30 janky.
//   LONG   = long tasks/min (main-thread blocks >50ms).
//   In a call: RTT, packet loss, and received-video fps / freezes (the
//            "screenshare is laggy" numbers).
function grade(v: number, ok: number, bad: number): string {
  if (v <= ok) return "var(--ok, #22c55e)";
  if (v <= bad) return "var(--rv-amber, #f59e0b)";
  return "var(--danger, #ef4444)";
}

function Row({ label, value, color }: { label: string; value: string; color?: string }): ReactElement {
  return (
    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
      <span style={{ opacity: 0.7 }}>{label}</span>
      <span style={{ color: color ?? "inherit", fontWeight: 600 }}>{value}</span>
    </div>
  );
}

export function DiagnosticsOverlay({ open }: { open: boolean }): ReactElement | null {
  const [ux, setUx] = useState<UxMetrics | null>(null);
  const [call, setCall] = useState<CallStats | null>(null);

  useEffect(() => {
    if (!open) return;
    const t = setInterval(() => {
      setUx(readUxMetrics());
      setCall(readCallStats());
    }, 500);
    return () => clearInterval(t);
  }, [open]);

  if (!open || !ux) return null;

  return (
    <div
      style={{
        position: "fixed",
        top: 44,
        right: 8,
        zIndex: 200,
        width: 208,
        padding: "8px 10px",
        borderRadius: 8,
        background: "rgba(15,15,17,0.86)",
        color: "#e8e8ea",
        font: "500 11px/1.6 var(--font-mono, ui-monospace, monospace)",
        border: "1px solid rgba(255,255,255,0.12)",
        boxShadow: "0 6px 20px rgba(0,0,0,0.4)",
        pointerEvents: "none",
        backdropFilter: "blur(6px)",
      }}
    >
      <div style={{ opacity: 0.55, letterSpacing: ".14em", fontSize: 9, marginBottom: 4 }}>DIAGNOSTICS · ⌃⇧D</div>
      <Row label="INP" value={`${ux.inpMs}ms`} color={grade(ux.inpMs, 200, 500)} />
      <Row label="block/s" value={`${ux.blockingMsPerSec}ms`} color={grade(ux.blockingMsPerSec, 50, 200)} />
      <Row label="fps" value={`${ux.fps}`} color={grade(60 - ux.fps, 15, 30)} />
      <Row label="longtasks/m" value={`${ux.longTasksPerMin}`} color={grade(ux.longTasksPerMin, 20, 60)} />
      {!ux.supported && <div style={{ opacity: 0.5, fontSize: 9, marginTop: 2 }}>limited metrics (browser)</div>}
      {call && (
        <>
          <div style={{ height: 1, background: "rgba(255,255,255,0.12)", margin: "5px 0" }} />
          <div style={{ opacity: 0.55, letterSpacing: ".14em", fontSize: 9, marginBottom: 4 }}>CALL</div>
          {call.rttMs != null && <Row label="rtt" value={`${call.rttMs}ms`} color={grade(call.rttMs, 80, 200)} />}
          {call.packetLossPct != null && (
            <Row label="loss" value={`${call.packetLossPct.toFixed(1)}%`} color={grade(call.packetLossPct, 1, 5)} />
          )}
          {call.videoFps != null && (
            <Row label="video fps" value={`${call.videoFps}${call.videoRes ? ` · ${call.videoRes}` : ""}`} color={grade(30 - call.videoFps, 10, 20)} />
          )}
          {call.freezes != null && <Row label="freezes" value={`${call.freezes}`} color={grade(call.freezes, 2, 10)} />}
          {call.bitrateKbps != null && <Row label="bitrate" value={`${Math.round(call.bitrateKbps)}k`} />}
        </>
      )}
    </div>
  );
}
