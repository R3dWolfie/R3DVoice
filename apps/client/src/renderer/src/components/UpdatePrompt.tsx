import { useEffect, useState, type CSSProperties, type ReactElement } from "react";
import { APP_VERSION, IS_WEB } from "./Primitives.js";
import { useAuthStore } from "../lib/auth-context.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import { compareVersions, fetchLatestClientVersion } from "../lib/update-check.js";
import { performUpdate } from "../lib/update-action.js";

const POLL_MS = 10 * 60 * 1000;

/**
 * Corner update prompt (a bigger target than the ambient titlebar button):
 * [Update] [Later] + a checkbox that turns off auto-updates AND silences this
 * popup forever (agreed UX). "Later" dismisses for the session only. The
 * ambient titlebar "Update" button remains regardless.
 */
export function UpdatePrompt(): ReactElement | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const hidden = usePrefs((s) => s.hideUpdatePopup);
  const [latest, setLatest] = useState<string | null>(null);
  const [canSelfUpdate, setCanSelfUpdate] = useState(false);
  const [pacman, setPacman] = useState(false);
  const [dismissed, setDismissed] = useState(false); // "Later" — this session only
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void window.r3dvoice
      ?.updaterInfo?.()
      .then((i) => {
        setCanSelfUpdate(Boolean(i?.canSelfUpdate));
        setPacman(Boolean(i?.pacman));
      })
      .catch(() => setCanSelfUpdate(false));
  }, []);
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

  const outdated = latest !== null && APP_VERSION !== "dev" && compareVersions(APP_VERSION, latest) < 0;
  if (!outdated || hidden || dismissed) return null;

  const doUpdate = async (): Promise<void> => {
    setBusy(true);
    const outcome = await performUpdate({ isWeb: IS_WEB, canSelfUpdate, pacman, version: latest });
    if (outcome === "pkg-launched") setMsg("Running your package manager. Confirm, then restart.");
    else if (outcome === "pkg-failed") setMsg("Couldn't launch a terminal. See Settings > Updates.");
    else setDismissed(true); // reload/relaunch — the app is going away anyway
    setBusy(false);
  };

  return (
    <div className="rv-fade-in" style={CARD}>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <span aria-hidden style={{ color: "var(--accent)", fontSize: 16, lineHeight: 1 }}>↑</span>
        <div style={{ fontWeight: 700, fontSize: "var(--t-sm)" }}>Update available</div>
      </div>
      <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)" }}>
        v{APP_VERSION} → <b style={{ color: "var(--accent)" }}>v{latest}</b>
      </div>
      {msg && <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)" }}>{msg}</div>}
      <div style={{ display: "flex", gap: 8 }}>
        <button
          type="button"
          className="rv-btn"
          data-variant="primary"
          disabled={busy}
          onClick={() => void doUpdate()}
          style={{ flex: 1 }}
        >
          {busy ? "Updating…" : "Update"}
        </button>
        <button type="button" className="rv-btn" data-variant="ghost" onClick={() => setDismissed(true)} style={{ flex: 1 }}>
          Later
        </button>
      </div>
      <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: "var(--t-2xs)", color: "var(--text-mid)", cursor: "pointer" }}>
        <input
          type="checkbox"
          onChange={(e) => {
            if (e.target.checked) {
              prefsActions().setAutoUpdate(false);
              prefsActions().setHideUpdatePopup(true); // stop asking, forever
            }
          }}
        />
        Turn off auto-updates (and stop showing this)
      </label>
    </div>
  );
}

const CARD: CSSProperties = {
  position: "fixed",
  right: 16,
  bottom: 16,
  zIndex: 300,
  width: 280,
  maxWidth: "92vw",
  display: "flex",
  flexDirection: "column",
  gap: "var(--s-3)",
  padding: "var(--s-4)",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  borderRadius: "var(--r-lg)",
  boxShadow: "0 12px 36px rgba(0,0,0,.5)",
};
