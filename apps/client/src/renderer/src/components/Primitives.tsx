import type { CSSProperties, ReactElement, ReactNode } from "react";

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
          {IS_WEB && (
            <a
              href="https://github.com/R3dWolfie/R3DVoice/releases/latest"
              target="_blank"
              rel="noopener noreferrer"
              title="Download the desktop app (Windows · macOS · Linux)"
              className="rv-btn"
              data-variant="ghost"
              style={{ height: "1.4rem", padding: "0 var(--s-2)", fontSize: "var(--t-2xs)", lineHeight: 1 }}
            >
              ↓ Download app
            </a>
          )}
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

