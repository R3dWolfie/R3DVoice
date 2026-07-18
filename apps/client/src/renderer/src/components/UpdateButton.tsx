import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { APP_VERSION, IS_WEB } from "./Primitives.js";
import { useAuthStore } from "../lib/auth-context.js";
import { compareVersions, fetchLatestClientVersion } from "../lib/update-check.js";

// How often to re-poll the server's latest version while the app stays open.
const POLL_MS = 10 * 60 * 1000;
// Copyable package-manager command for installs that can't self-update (AUR).
const PKG_CMD = "yay -Syu";

/**
 * Ambient, non-blocking "update available" affordance for the titlebar. Polls
 * the server's own version (via /health) and, when this build is older, shows a
 * small accent-tinted "↑ Update" button. Clicking opens a tiny popover whose
 * action depends on how the app was installed:
 *   - web             → Reload (serves the fresh bundle)
 *   - AppImage/exe/dmg → Restart (the launch-time updater force-installs)
 *   - AUR/other        → show the package-manager command (copyable)
 *
 * This is the soft counterpart to UpdateGate, which stays the hard version
 * floor. When no newer version exists, this renders nothing.
 */
export function UpdateButton(): ReactElement | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const [latest, setLatest] = useState<string | null>(null);
  const [canSelfUpdate, setCanSelfUpdate] = useState(false);
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Capability probe — true only for a packaged, self-updating build.
  useEffect(() => {
    void window.r3dvoice?.updaterInfo?.()
      .then((i) => setCanSelfUpdate(Boolean(i?.canSelfUpdate)))
      .catch(() => setCanSelfUpdate(false));
  }, []);

  // Poll the server's latest version on mount + periodically.
  useEffect(() => {
    if (!serverUrl) return;
    let cancelled = false;
    const check = async (): Promise<void> => {
      const v = await fetchLatestClientVersion(serverUrl);
      if (!cancelled) setLatest(v);
    };
    void check();
    const t = setInterval(() => void check(), POLL_MS);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [serverUrl]);

  // Close the popover on any outside click (mirrors DownloadMenu).
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  // Skip literal "dev" builds (no injected version) so they don't nag forever.
  const outdated = latest !== null && APP_VERSION !== "dev" && compareVersions(APP_VERSION, latest) < 0;
  if (!outdated) return null;

  const copyCmd = (): void => {
    void navigator.clipboard?.writeText(PKG_CMD).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };

  return (
    <div ref={ref} style={{ position: "relative" }}>
      <button
        type="button"
        className="rv-btn"
        data-variant="ghost"
        data-active={open}
        title={`Update available — v${latest}`}
        onClick={() => setOpen((v) => !v)}
        style={BTN}
      >
        ↑ Update
      </button>
      {open && (
        <div
          className="rv-menu rv-fade-in"
          style={{ position: "absolute", top: "calc(100% + 6px)", right: 0, minWidth: 230, zIndex: 60, padding: "var(--s-3)" }}
        >
          <div style={{ fontSize: "var(--t-xs)", fontWeight: 600, marginBottom: "var(--s-1)" }}>
            Update available
          </div>
          <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)", marginBottom: "var(--s-3)" }}>
            v{APP_VERSION} → <b style={{ color: "var(--accent)" }}>v{latest}</b>
          </div>

          {IS_WEB ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              style={ACTION}
              onClick={() => window.location.reload()}
            >
              Reload to update
            </button>
          ) : canSelfUpdate ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              style={ACTION}
              onClick={() => void window.r3dvoice.relaunch()}
            >
              Restart to update
            </button>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
              <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)" }}>
                Update with your package manager:
              </div>
              <code style={CODE}>{PKG_CMD}</code>
              <button type="button" className="rv-btn" data-variant="ghost" style={ACTION} onClick={copyCmd}>
                {copied ? "Copied!" : "Copy command"}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// Small + subtle, but accent-tinted so an available update reads as actionable.
const BTN: CSSProperties = {
  height: "1.4rem",
  padding: "0 var(--s-2)",
  fontSize: "var(--t-2xs)",
  lineHeight: 1,
  fontWeight: 600,
  color: "var(--accent)",
  background: "var(--accent-tint)",
  borderColor: "color-mix(in oklch, var(--accent) 45%, transparent)",
};

const ACTION: CSSProperties = { width: "100%", height: "1.9rem", fontSize: "var(--t-xs)", fontWeight: 600 };

const CODE: CSSProperties = {
  display: "block",
  padding: "var(--s-2) var(--s-3)",
  borderRadius: "var(--r-sm)",
  background: "var(--bg)",
  border: "1px solid var(--border)",
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--t-2xs)",
};
