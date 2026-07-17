import { useEffect, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { I } from "./Icons.js";

// Generic modal shell, deck anatomy (WireFrames/4-modals): flat dim backdrop,
// header with optional icon plate + title + subtitle, scrollable body, and an
// optional footer band. Backdrop click and ESC close unless dismissible=false
// (gates like handle-pick must not be escapable).
export function Modal({
  open,
  onClose,
  title,
  subtitle,
  icon,
  footer,
  dismissible = true,
  width = "min(94vw, 720px)",
  children,
}: {
  open: boolean;
  onClose: () => void;
  title: string;
  subtitle?: string;
  /** Small glyph rendered in a bordered square plate left of the title. */
  icon?: ReactNode;
  /** Footer band content (deck: hint left, actions right). */
  footer?: ReactNode;
  dismissible?: boolean;
  width?: string;
  children: ReactNode;
}): ReactElement | null {
  useEffect(() => {
    if (!open || !dismissible) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissible, onClose]);

  if (!open) return null;

  // Portal to <body>: ancestors with transform/filter/backdrop-filter (e.g.
  // RoomInfoPanel's blur) become containing blocks for position:fixed and
  // would trap the "fullscreen" backdrop inside their own box.
  return createPortal(
    <div
      onClick={dismissible ? onClose : undefined}
      style={{
        position: "fixed",
        inset: 0,
        zIndex: 80,
        background: "rgba(20,20,20,0.55)",
        display: "grid",
        placeItems: "center",
        animation: "rv-fade var(--d-mid) var(--ease-out) both",
      }}
    >
      <div
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxHeight: "82vh",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--shadow-3)",
          display: "grid",
          gridTemplateRows: footer ? "auto 1fr auto" : "auto 1fr",
          overflow: "hidden",
          animation: "rv-modal-in var(--d-mid) var(--ease-out) both",
        }}
      >
        <header
          style={{
            padding: "var(--s-5) var(--s-6) var(--s-4)",
            borderBottom: "1px solid var(--border-soft)",
            display: "flex",
            alignItems: "flex-start",
            gap: "var(--s-3)",
          }}
        >
          {icon && (
            <div
              aria-hidden
              style={{
                width: "2.25rem",
                height: "2.25rem",
                borderRadius: "var(--r-md)",
                background: "var(--bg-elev-2)",
                border: "1px solid var(--border-soft)",
                display: "grid",
                placeItems: "center",
                fontFamily: "var(--font-mono)",
                fontSize: "var(--t-lg)",
                fontWeight: 700,
                flexShrink: 0,
              }}
            >
              {icon}
            </div>
          )}
          <div style={{ minWidth: 0, flex: 1 }}>
            <div style={{ fontSize: "var(--t-lg)", fontWeight: 600, letterSpacing: "-0.01em" }}>
              {title}
            </div>
            {subtitle && (
              <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)", marginTop: 3 }}>
                {subtitle}
              </div>
            )}
          </div>
          {dismissible && (
            <button
              className="rv-btn rv-btn-icon"
              data-variant="ghost"
              onClick={onClose}
              aria-label="Close"
            >
              <I.X size={16} />
            </button>
          )}
        </header>
        <div style={{ overflow: "auto", minHeight: 0 }} className="rv-scroll">
          {children}
        </div>
        {footer && (
          <div
            style={{
              padding: "var(--s-4) var(--s-6)",
              borderTop: "1px solid var(--border-soft)",
              background: "var(--bg-elev-2)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              gap: "var(--s-3)",
            }}
          >
            {footer}
          </div>
        )}
      </div>
    </div>,
    document.body,
  );
}
