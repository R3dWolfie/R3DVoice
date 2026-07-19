import { useState, type CSSProperties, type ReactElement, type ReactNode } from "react";
import { UpdateButton } from "./UpdateButton.js";
import { Modal } from "./Modal.js";

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

const PLATFORM_TAG: CSSProperties = {
  fontFamily: "var(--font-mono, monospace)",
  fontSize: "var(--t-2xs)",
  padding: "2px 7px",
  borderRadius: "var(--r-sm)",
  background: "var(--bg-elev-3)",
  color: "var(--text-mid)",
  whiteSpace: "nowrap",
  flexShrink: 0,
};

const PRIMARY_DL_CARD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--s-4)",
  padding: "var(--s-4) var(--s-5)",
  borderRadius: "var(--r-lg)",
  border: "1px solid color-mix(in oklch, var(--accent) 45%, transparent)",
  background: "var(--accent-tint)",
  color: "var(--text)",
  textDecoration: "none",
};

const SECONDARY_DL_CARD: CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: "var(--s-3)",
  padding: "var(--s-3) var(--s-4)",
  borderRadius: "var(--r-md)",
  border: "1px solid var(--border)",
  background: "var(--bg-elev-2)",
  color: "var(--text)",
  textDecoration: "none",
};

const ext = (sub: string): string => sub.split(" ")[0] ?? sub;

/** Web-only: opens a polished modal to grab the desktop app (detected OS first). */
function DownloadMenu(): ReactElement {
  const [open, setOpen] = useState(false);
  const os = detectOS();
  const detected = PLATFORMS.find((p) => p.key === os) ?? null;
  const others = PLATFORMS.filter((p) => p.key !== os);

  return (
    <>
      <button
        type="button"
        className="rv-btn"
        data-variant="ghost"
        data-active={open}
        title="Download the desktop app"
        onClick={() => setOpen(true)}
        style={{ height: "1.4rem", padding: "0 var(--s-2)", fontSize: "var(--t-2xs)", lineHeight: 1 }}
      >
        ↓ Download app
      </button>
      <Modal
        open={open}
        onClose={() => setOpen(false)}
        title="Download R3DVoice"
        subtitle="The native desktop app - lower latency, global hotkeys, per-app screen audio"
        icon="↓"
        width="min(94vw, 540px)"
        footer={
          <>
            <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
              Free · open source · AGPL-3.0
            </span>
            <a
              href={`${RELEASES}/latest`}
              target="_blank"
              rel="noopener noreferrer"
              className="rv-btn"
              data-variant="ghost"
              style={{ fontSize: "var(--t-xs)" }}
            >
              All builds & notes →
            </a>
          </>
        }
      >
        <div style={{ padding: "var(--s-5) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
          {detected && (
            <a href={detected.url} style={PRIMARY_DL_CARD}>
              <span aria-hidden style={{ fontSize: "1.7rem", lineHeight: 1, color: "var(--accent)" }}>
                ↓
              </span>
              <span style={{ display: "flex", flexDirection: "column", gap: 3, minWidth: 0 }}>
                <span style={{ fontWeight: 700, fontSize: "var(--t-md)" }}>Download for {detected.label}</span>
                <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)" }}>
                  Detected your system · {detected.sub}
                </span>
              </span>
              <span style={{ ...PLATFORM_TAG, marginLeft: "auto" }}>{ext(detected.sub)}</span>
            </a>
          )}

          <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
            <span className="rv-label" style={{ fontSize: "var(--t-2xs)", opacity: 0.7 }}>
              {detected ? "Other platforms" : "Choose your platform"}
            </span>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: others.length > 1 ? "1fr 1fr" : "1fr",
                gap: "var(--s-3)",
              }}
            >
              {others.map((p) => (
                <a key={p.key} href={p.url} style={SECONDARY_DL_CARD}>
                  <span style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
                    <span style={{ fontWeight: 600, fontSize: "var(--t-sm)" }}>{p.label}</span>
                    <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>{p.sub}</span>
                  </span>
                  <span style={{ ...PLATFORM_TAG, marginLeft: "auto" }}>{ext(p.sub)}</span>
                </a>
              ))}
            </div>
          </div>

          {os === "linux" && (
            <div
              style={{
                display: "flex",
                flexWrap: "wrap",
                alignItems: "center",
                gap: "var(--s-2)",
                padding: "var(--s-3) var(--s-4)",
                borderRadius: "var(--r-md)",
                border: "1px dashed var(--border)",
                background: "var(--bg-elev)",
              }}
            >
              <span style={{ fontSize: "var(--t-2xs)", color: "var(--text-mid)" }}>
                On Arch? Install from the AUR - updates come through your package manager:
              </span>
              <code style={{ ...PLATFORM_TAG, fontSize: "var(--t-xs)" }}>yay -S r3dvoice-bin</code>
            </div>
          )}
        </div>
      </Modal>
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

