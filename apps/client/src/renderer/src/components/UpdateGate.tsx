import { useEffect, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { APP_VERSION, IS_WEB } from "./Primitives.js";
import { fetchMinClientVersion, isUpdateRequired } from "../lib/update-check.js";
import { performUpdate } from "../lib/update-action.js";

/**
 * Wraps the app and enforces the server's minimum client version. When this
 * build is older than the floor, a non-dismissable overlay covers everything;
 * the action depends on how the app was installed:
 *   - web            → Reload (gets the freshly-served bundle)
 *   - AppImage/exe/dmg → Restart (the launch-time updater force-installs)
 *   - AUR/deb        → run the package-manager command, then Recheck
 */
export function UpdateGate({ serverUrl, children }: { serverUrl: string; children: ReactNode }): ReactElement {
  const [minVersion, setMinVersion] = useState<string | null>(null);
  const [canSelfUpdate, setCanSelfUpdate] = useState(false);
  const [pacman, setPacman] = useState(false);
  const [checking, setChecking] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  useEffect(() => {
    void window.r3dvoice?.updaterInfo?.()
      .then((i) => {
        setCanSelfUpdate(Boolean(i?.canSelfUpdate));
        setPacman(Boolean(i?.pacman));
      })
      .catch(() => setCanSelfUpdate(false));
  }, []);

  useEffect(() => {
    let cancelled = false;
    const check = async (): Promise<void> => {
      const min = await fetchMinClientVersion(serverUrl);
      if (!cancelled) setMinVersion(min);
    };
    void check();
    // Re-check periodically so a floor raised mid-session eventually gates a
    // long-lived tab/window without needing a manual reload.
    const t = setInterval(() => void check(), 5 * 60 * 1000);
    return () => {
      cancelled = true;
      clearInterval(t);
    };
  }, [serverUrl]);

  const required = isUpdateRequired(APP_VERSION, minVersion);
  if (!required) return <>{children}</>;

  const recheck = async (): Promise<void> => {
    setChecking(true);
    setMinVersion(await fetchMinClientVersion(serverUrl));
    setChecking(false);
  };

  return (
    <>
      {children}
      <div style={OVERLAY}>
        <div style={CARD}>
          <div style={{ fontSize: 40, lineHeight: 1 }}>⬆️</div>
          <h1 style={{ margin: 0, fontSize: "var(--t-xl)", fontWeight: 700 }}>Update required</h1>
          <p style={{ margin: 0, color: "var(--text-mid)", lineHeight: 1.5 }}>
            You&rsquo;re on <b>v{APP_VERSION}</b>, but this server now requires{" "}
            <b>v{minVersion}</b> or newer. Update to keep using R3DVoice.
          </p>

          {IS_WEB ? (
            <button type="button" className="rv-btn" data-variant="primary" style={BTN} onClick={() => window.location.reload()}>
              Reload
            </button>
          ) : canSelfUpdate ? (
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              style={BTN}
              onClick={() => void window.r3dvoice.relaunch()}
            >
              Restart to update
            </button>
          ) : pacman ? (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", width: "100%" }}>
              <button
                type="button"
                className="rv-btn"
                data-variant="primary"
                style={BTN}
                disabled={busy}
                onClick={async () => {
                  setBusy(true);
                  setMsg(null);
                  const outcome = await performUpdate({ isWeb: false, canSelfUpdate: false, pacman: true, version: minVersion });
                  if (outcome === "pkg-launched") setMsg("Opened a terminal - confirm there, then reopen R3DVoice.");
                  else if (outcome === "pkg-failed") setMsg("Couldn't install automatically - run yay -Syu, then recheck.");
                  setBusy(false); // on success the app relaunches
                }}
              >
                {busy ? "Installing…" : "↑ Update now"}
              </button>
              <div style={{ color: "var(--text-dim)", fontSize: "var(--t-xs)" }}>
                Installs with one password prompt, then restarts.
              </div>
              {msg && <div style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)" }}>{msg}</div>}
              <button
                type="button"
                className="rv-btn"
                data-variant="ghost"
                style={{ ...BTN, height: "2.2rem", fontSize: "var(--t-sm)" }}
                disabled={checking}
                onClick={() => void recheck()}
              >
                {checking ? "Checking…" : "I've updated - recheck"}
              </button>
            </div>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)", width: "100%" }}>
              <div style={{ color: "var(--text-mid)", fontSize: "var(--t-sm)" }}>Update with your package manager:</div>
              <code
                style={{
                  display: "block",
                  padding: "var(--s-2) var(--s-3)",
                  borderRadius: "var(--r-sm)",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  fontFamily: "var(--font-mono, monospace)",
                  fontSize: "var(--t-sm)",
                }}
              >
                yay -Syu
              </code>
              <button type="button" className="rv-btn" data-variant="primary" style={BTN} disabled={checking} onClick={() => void recheck()}>
                {checking ? "Checking…" : "I've updated - recheck"}
              </button>
            </div>
          )}
        </div>
      </div>
    </>
  );
}

const OVERLAY: CSSProperties = {
  position: "fixed",
  inset: 0,
  zIndex: 9999,
  background: "color-mix(in oklch, var(--bg) 88%, transparent)",
  backdropFilter: "blur(6px)",
  display: "grid",
  placeItems: "center",
  padding: "var(--s-5)",
};

const CARD: CSSProperties = {
  width: "min(420px, 100%)",
  display: "flex",
  flexDirection: "column",
  alignItems: "center",
  gap: "var(--s-4)",
  textAlign: "center",
  padding: "var(--s-6) var(--s-5)",
  borderRadius: "var(--r-lg)",
  background: "var(--bg-elev)",
  border: "1px solid var(--border)",
  boxShadow: "var(--shadow-lg, 0 12px 48px rgba(0,0,0,.4))",
};

const BTN: CSSProperties = { width: "100%", height: "2.6rem", fontSize: "var(--t-md)", fontWeight: 600 };
