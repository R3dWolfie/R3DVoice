import { useEffect, useRef, useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { UpdateButton } from "./UpdateButton.js";

// Vite-injected at build time from apps/client/package.json.
declare const __APP_VERSION__: string;
export const APP_VERSION = typeof __APP_VERSION__ === "string" ? __APP_VERSION__ : "dev";

// True in the browser build, false inside the Electron desktop app (whose
// renderer UA carries "Electron"). Drives the web-only "Download app" link.
export const IS_WEB =
  typeof navigator !== "undefined" && !/electron/i.test(navigator.userAgent);

export function WindowChrome({
  title,
  version = `v${APP_VERSION}`,
  serverLabel,
  children,
}: {
  title: string;
  version?: string;
  /** Optional server URL host (e.g. "voice.r3dwolfie.com"). Hidden if absent. */
  serverLabel?: string | undefined;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rv-window">
      <div className="rv-titlebar">
        <div className="rv-titlebar-left">
          <span className="rv-titlebar-title">{title}</span>
        </div>
        <div className="rv-titlebar-right" style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <UpdateButton />
          {IS_WEB && <DownloadMenu />}
          <span className="rv-titlebar-title" style={{ opacity: 0.6 }}>
            {version}
            {serverLabel ? ` · ${serverLabel}` : ""}
          </span>
        </div>
      </div>
      {children}
    </div>
  );
}

const RELEASES = "https://github.com/R3dWolfie/R3DVoice/releases";
const dl = (asset: string): string => `${RELEASES}/latest/download/${asset}`;
const PLATFORMS = [
  { key: "windows", label: "Windows", sub: ".exe installer", url: dl("R3DVoice-Setup.exe") },
  { key: "mac", label: "macOS", sub: ".dmg", url: dl("R3DVoice.dmg") },
  { key: "linux", label: "Linux", sub: ".AppImage", url: dl("R3DVoice.AppImage") },
] as const;

function detectOS(): "windows" | "mac" | "linux" | "other" {
  if (typeof navigator === "undefined") return "other";
  const ua = navigator.userAgent;
  if (/windows|win32|win64/i.test(ua)) return "windows";
  if (/mac os|macintosh|iphone|ipad/i.test(ua)) return "mac";
  if (/linux|x11|android/i.test(ua)) return "linux";
  return "other";
}

const DL_ITEM: CSSProperties = {
  display: "flex",
  alignItems: "baseline",
  gap: "var(--s-2)",
  padding: "var(--s-2) var(--s-3)",
  borderRadius: "var(--r-sm)",
  color: "var(--text)",
  textDecoration: "none",
  fontSize: "var(--t-xs)",
  whiteSpace: "nowrap",
};

/** Web-only: OS-detecting desktop-download popup (detected build + others + GitHub). */
function DownloadMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const btnRef = useRef<HTMLButtonElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; right: number } | null>(null);

  // Anchor the portaled popover under the trigger (see UpdateButton — the
  // titlebar shares a stacking context with the content area, so an in-place
  // absolute popover paints *behind* the app).
  const place = (): void => {
    const r = btnRef.current?.getBoundingClientRect();
    if (r) setPos({ top: r.bottom + 6, right: Math.max(8, window.innerWidth - r.right) });
  };

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

  const os = detectOS();
  const detected = PLATFORMS.find((p) => p.key === os) ?? null;
  const others = PLATFORMS.filter((p) => p.key !== os);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="rv-btn"
        data-variant="ghost"
        data-active={open}
        title="Download the desktop app"
        onClick={() => {
          if (!open) place();
          setOpen((v) => !v);
        }}
        style={{ height: "1.4rem", padding: "0 var(--s-2)", fontSize: "var(--t-2xs)", lineHeight: 1 }}
      >
        ↓ Download app ▾
      </button>
      {open &&
        pos &&
        createPortal(
        <div
          ref={menuRef}
          className="rv-menu rv-fade-in"
          style={{ position: "fixed", top: pos.top, right: pos.right, minWidth: 230, zIndex: 4000, padding: "var(--s-1)" }}
          onClick={() => setOpen(false)}
        >
          {detected && (
            <a href={detected.url} style={{ ...DL_ITEM, fontWeight: 600, color: "var(--accent)" }}>
              ↓ Download for {detected.label}
              <span style={{ color: "var(--text-faint)", fontWeight: 400 }}>{detected.sub}</span>
            </a>
          )}
          <div className="rv-label" style={{ padding: "var(--s-1) var(--s-3)", fontSize: "var(--t-2xs)", opacity: 0.7 }}>
            {detected ? "Other platforms" : "Choose your platform"}
          </div>
          {others.map((p) => (
            <a key={p.key} href={p.url} style={DL_ITEM}>
              {p.label}
              <span style={{ color: "var(--text-faint)" }}>{p.sub}</span>
            </a>
          ))}
          <div style={{ height: 1, background: "var(--border-soft)", margin: "var(--s-1) 0" }} />
          <a href={`${RELEASES}/latest`} target="_blank" rel="noopener noreferrer" style={{ ...DL_ITEM, color: "var(--text-mid)" }}>
            GitHub Download →
          </a>
        </div>,
        document.body,
      )}
    </>
  );
}

export function Field({
  label,
  hint,
  right,
  children,
}: {
  label: string;
  hint?: string;
  right?: ReactNode;
  children: ReactNode;
}): ReactElement {
  return (
    <div className="rv-field">
      <div className="rv-field-label">
        <span className="rv-label">{label}</span>
        {right}
      </div>
      {children}
      {hint && <span className="rv-field-help">{hint}</span>}
    </div>
  );
}

export function Spinner(): ReactElement {
  return (
    <span
      style={{
        display: "inline-block",
        width: 14,
        height: 14,
        border: "2px solid currentColor",
        borderTopColor: "transparent",
        borderRadius: "50%",
        animation: "rv-spin .7s linear infinite",
      }}
    />
  );
}

