import { useCallback, useEffect, useState, type CSSProperties, type ReactElement } from "react";
import type { MuteLevel } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";

// Timed-mute popover per WireFrames 2.4b: level radios (all / @mentions /
// muted), duration chips (1h/3h/8h/24h/∞), a "currently muted till…" banner
// with Cancel mute, and Cancel / Apply mute footer. Backed by
// PATCH /chat/threads/:threadType/:threadId/mute { level, mutedUntil }.

const DURATIONS = [
  { key: "1h", hours: 1 },
  { key: "3h", hours: 3 },
  { key: "8h", hours: 8 },
  { key: "24h", hours: 24 },
  { key: "∞", hours: null },
] as const;

type DurationKey = (typeof DURATIONS)[number]["key"];

function fmtMutedUntil(iso: string): string {
  const d = new Date(iso);
  const now = new Date();
  const time = d.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  const day =
    d.toDateString() === now.toDateString()
      ? "today"
      : d.toDateString() === new Date(now.getTime() + 86_400_000).toDateString()
        ? "tomorrow"
        : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${time} ${day}`;
}

function fmtRemaining(iso: string): string | null {
  const ms = new Date(iso).getTime() - Date.now();
  if (ms <= 0) return null;
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  return h > 0 ? `${h}h ${m}m left` : `${m}m left`;
}

export function MutePopover({
  threadType,
  threadId,
  targetLabel,
  onClose,
  onChanged,
  style,
}: {
  threadType: "room" | "dm";
  threadId: string;
  /** "@alice" / room name — rendered in the "Mute …" header. */
  targetLabel: string;
  onClose: () => void;
  /** Fires after a successful apply / cancel-mute with the new state. */
  onChanged?: ((level: MuteLevel, mutedUntil: string | null) => void) | undefined;
  /** Positioning overrides (defaults to an absolute dropdown surface). */
  style?: CSSProperties | undefined;
}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);

  const [current, setCurrent] = useState<{ level: MuteLevel; mutedUntil: string | null } | null>(null);
  const [level, setLevel] = useState<MuteLevel>("all");
  const [duration, setDuration] = useState<DurationKey>("∞");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  }, [serverUrl, token]);

  useEffect(() => {
    let cancelled = false;
    apiFor()
      .getMute(threadType, threadId)
      .then((r) => {
        if (cancelled) return;
        setCurrent({ level: r.level, mutedUntil: r.mutedUntil });
        setLevel(r.level);
      })
      .catch(() => {
        if (!cancelled) setCurrent({ level: "all", mutedUntil: null });
      });
    return () => {
      cancelled = true;
    };
  }, [apiFor, threadType, threadId]);

  const submit = async (nextLevel: MuteLevel, mutedUntil: string | null): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await apiFor().setMute(threadType, threadId, nextLevel, mutedUntil);
      getTransport()?.invalidateMute(threadType, threadId);
      onChanged?.(nextLevel, mutedUntil);
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to update mute");
      setBusy(false);
    }
  };

  const apply = (): void => {
    const hours = DURATIONS.find((d) => d.key === duration)?.hours ?? null;
    const mutedUntil =
      level === "all" || hours === null ? null : new Date(Date.now() + hours * 3_600_000).toISOString();
    void submit(level, mutedUntil);
  };

  const currentlyMuted = current !== null && current.level !== "all";
  const remaining = current?.mutedUntil ? fmtRemaining(current.mutedUntil) : null;

  return (
    <>
      <div onClick={onClose} style={{ position: "fixed", inset: 0, zIndex: 60 }} />
      <div
        className="rv-menu rv-fade-in"
        style={{
          position: "absolute",
          top: "calc(100% + 4px)",
          right: 0,
          zIndex: 61,
          width: 280,
          padding: 0,
          overflow: "hidden",
          ...style,
        }}
      >
        {/* Header */}
        <div
          style={{
            padding: "var(--s-3) var(--s-4)",
            borderBottom: "1px solid var(--border-soft)",
            fontWeight: 600,
            fontSize: "var(--t-sm)",
          }}
        >
          Mute {targetLabel}
        </div>

        {/* Currently muted? show timer + cancel option at top (2.4b) */}
        {currentlyMuted && (
          <div className="rv-mute-banner">
            <span style={{ color: "var(--rv-amber)", fontWeight: 700 }}>●</span>
            <span style={{ flex: 1 }}>
              {current?.mutedUntil && remaining ? (
                <>
                  Muted till <strong style={{ color: "var(--text)" }}>{fmtMutedUntil(current.mutedUntil)}</strong>
                  {" · "}
                  {remaining}
                </>
              ) : (
                "Muted until you turn it back on"
              )}
            </span>
            <button
              type="button"
              className="rv-btn"
              disabled={busy}
              onClick={() => void submit("all", null)}
              style={{ height: "1.5rem", padding: "0 var(--s-2)", fontSize: "var(--t-2xs)" }}
            >
              Cancel mute
            </button>
          </div>
        )}

        {/* Level radios */}
        <div style={{ padding: "var(--s-2)" }}>
          {(
            [
              ["all", "All notifications", "Default · every new message pings"],
              ["mentions", "@mentions only", "Quiet, but pings if they @ you"],
              ["none", "Muted", "Silent · no pings, no badge"],
            ] as Array<[MuteLevel, string, string]>
          ).map(([value, label, help]) => (
            <button key={value} type="button" className="rv-radio-row" onClick={() => setLevel(value)}>
              <span className="rv-radio" data-on={level === value} />
              <span className="rv-radio-label">
                <span style={{ fontWeight: level === value ? 600 : 500 }}>{label}</span>
                <span className="help">{help}</span>
              </span>
            </button>
          ))}
        </div>

        {/* Duration */}
        <div style={{ padding: "var(--s-2) var(--s-4) var(--s-4)", borderTop: "1px solid var(--border-soft)" }}>
          <div className="rv-label" style={{ fontSize: "var(--t-2xs)", margin: "var(--s-2) 0" }}>
            For how long
          </div>
          <div className="rv-dur-row" style={level === "all" ? { opacity: 0.45, pointerEvents: "none" } : undefined}>
            {DURATIONS.map((d) => (
              <button
                key={d.key}
                type="button"
                className="rv-dur-chip"
                data-active={duration === d.key}
                onClick={() => setDuration(d.key)}
              >
                {d.key}
              </button>
            ))}
          </div>
          <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)", marginTop: 6 }}>
            ∞ = until I turn it back on
          </div>
          {error && (
            <div style={{ fontSize: "var(--t-xs)", color: "var(--danger)", marginTop: 6 }}>{error}</div>
          )}
          <div
            style={{
              display: "flex",
              justifyContent: "flex-end",
              gap: "var(--s-2)",
              marginTop: "var(--s-3)",
              borderTop: "1px solid var(--border-soft)",
              paddingTop: "var(--s-3)",
            }}
          >
            <button
              type="button"
              className="rv-btn"
              data-variant="ghost"
              onClick={onClose}
              style={{ height: "1.9rem", fontSize: "var(--t-xs)" }}
            >
              Cancel
            </button>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              disabled={busy || current === null}
              onClick={apply}
              style={{ height: "1.9rem", fontSize: "var(--t-xs)" }}
            >
              Apply mute
            </button>
          </div>
        </div>
      </div>
    </>
  );
}
