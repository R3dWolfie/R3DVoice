import { useEffect, useRef, useState, type CSSProperties, type ReactElement } from "react";
import { createPortal } from "react-dom";
import { APP_VERSION, IS_WEB } from "./Primitives.js";
import { useAuthStore } from "../lib/auth-context.js";
import { compareVersions, fetchLatestClientVersion } from "../lib/update-check.js";

// How often to re-poll the server's latest version while the app stays open.
const POLL_MS = 10 * 60 * 1000;
// Copyable package-manager command for installs that can't self-update (AUR).
const PKG_CMD = "yay -Syu";

/**
 * Web "update now": a plain location.reload() can be served the stale bundle
 * back by a service worker, PWA cache, or an edge/CDN cache in front of the
 * origin — the app looks like it "did nothing". Clear any SW + Cache Storage,
 * then reload past caches with a one-shot bust param so the fresh index.html
 * (and its new content-hashed bundle) is actually fetched.
 */
async function reloadFresh(): Promise<void> {
  try {
    if ("serviceWorker" in navigator) {
      const regs = await navigator.serviceWorker.getRegistrations();
      await Promise.all(regs.map((r) => r.unregister()));
    }
    if (typeof caches !== "undefined") {
      const keys = await caches.keys();
      await Promise.all(keys.map((k) => caches.delete(k)));
    }
  } catch {
    /* best-effort — fall through to the reload regardless */
  }
  try {
    const u = new URL(window.location.href);
    u.searchParams.set("_u", Date.now().toString(36));
    window.location.replace(u.toString());
  } catch {
    window.location.reload();
  }
}

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
  const [pkgMsg, setPkgMsg] = useState<string | null>(null);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Anchor the portaled popover just under the titlebar trigger.
  const place = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };

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

  // Close on outside click. The popover is portaled to <body>, so it's outside
  // the trigger's DOM subtree — check both. Reposition if the window resizes.
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent): void => {
      const t = e.target as Node;
      if (!btnRef.current?.contains(t) && !menuRef.current?.contains(t)) setOpen(false);
    };
    const onResize = (): void => place();
    document.addEventListener("mousedown", onDoc);
    window.addEventListener("resize", onResize);
    return () => {
      document.removeEventListener("mousedown", onDoc);
      window.removeEventListener("resize", onResize);
    };
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
    <>
      <button
        ref={btnRef}
        type="button"
        className="rv-btn"
        data-variant="ghost"
        data-active={open}
        title={`Update available — v${latest}`}
        onClick={() => {
          if (!open) place();
          setOpen((v) => !v);
        }}
        style={BTN}
      >
        ↑ Update
      </button>
      {open &&
        pos &&
        createPortal(
          <div
            ref={menuRef}
            className="rv-menu rv-fade-in"
            style={{ position: "fixed", top: pos.top, right: pos.right, minWidth: 230, zIndex: 4000, padding: "var(--s-3)" }}
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
                onClick={() => void reloadFresh()}
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
                <button
                  type="button"
                  className="rv-btn"
                  data-variant="primary"
                  style={ACTION}
                  onClick={async () => {
                    setPkgMsg("Opening a terminal…");
                    let launched = false;
                    try {
                      const r = await window.r3dvoice?.runPackageUpdate?.();
                      launched = Boolean(r?.launched);
                    } catch {
                      /* fall through to the copy fallback */
                    }
                    if (launched) {
                      setPkgMsg("Running yay -Syu — confirm in the terminal, then restart R3DVoice.");
                    } else {
                      setPkgMsg("No terminal found — copied the command instead.");
                      copyCmd();
                    }
                  }}
                >
                  ↑ Update now
                </button>
                {pkgMsg ? (
                  <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)" }}>{pkgMsg}</div>
                ) : (
                  <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)" }}>
                    Runs <code style={{ ...CODE, display: "inline", padding: "1px 6px" }}>{PKG_CMD}</code> in your terminal.
                  </div>
                )}
                <button
                  type="button"
                  className="rv-btn"
                  data-variant="ghost"
                  style={{ ...ACTION, height: "1.7rem", fontSize: "var(--t-2xs)" }}
                  onClick={copyCmd}
                >
                  {copied ? "Copied!" : "Copy command instead"}
                </button>
              </div>
            )}
          </div>,
          document.body,
        )}
    </>
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
