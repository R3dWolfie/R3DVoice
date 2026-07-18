import { useEffect, useId, useRef, type ReactElement, type ReactNode } from "react";
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
  hideHeader = false,
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
  /** Drop the built-in title header (the surface supplies its own chrome,
      e.g. the Settings / Room-settings nav-rail + per-pane header). */
  hideHeader?: boolean;
  width?: string;
  children: ReactNode;
}): ReactElement | null {
  const titleId = useId();
  const contentRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open || !dismissible) return;
    function onKey(e: KeyboardEvent): void {
      if (e.key === "Escape") onClose();
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissible, onClose]);

  // Dialog focus management: pull focus into the modal on open (unless an
  // autoFocus field already grabbed it), trap Tab within it, and restore focus
  // to the previously-focused element on close.
  useEffect(() => {
    if (!open) return;
    const content = contentRef.current;
    if (!content) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const selector =
      'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';
    const focusables = (): HTMLElement[] =>
      Array.from(content.querySelectorAll<HTMLElement>(selector)).filter(
        (el) => el.getClientRects().length > 0,
      );

    if (!content.contains(document.activeElement)) {
      (focusables()[0] ?? content).focus();
    }

    function onKeyDown(e: KeyboardEvent): void {
      if (e.key !== "Tab") return;
      const items = focusables();
      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;
      if (!first || !last) {
        e.preventDefault();
        content!.focus();
        return;
      }
      if (e.shiftKey && (active === first || !content!.contains(active))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (active === last || !content!.contains(active))) {
        e.preventDefault();
        first.focus();
      }
    }
    content.addEventListener("keydown", onKeyDown);
    return () => {
      content.removeEventListener("keydown", onKeyDown);
      previouslyFocused?.focus?.();
    };
  }, [open]);

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
        ref={contentRef}
        role="dialog"
        aria-modal="true"
        {...(hideHeader ? { "aria-label": title } : { "aria-labelledby": titleId })}
        tabIndex={-1}
        onClick={(e) => e.stopPropagation()}
        style={{
          width,
          maxHeight: "82vh",
          background: "var(--bg-elev)",
          border: "1px solid var(--border)",
          borderRadius: "var(--r-xl)",
          boxShadow: "var(--shadow-3)",
          display: "grid",
          gridTemplateRows: hideHeader
            ? footer
              ? "1fr auto"
              : "1fr"
            : footer
              ? "auto 1fr auto"
              : "auto 1fr",
          overflow: "hidden",
          animation: "rv-modal-in var(--d-mid) var(--ease-out) both",
        }}
      >
        {!hideHeader && (
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
            <div id={titleId} style={{ fontSize: "var(--t-lg)", fontWeight: 600, letterSpacing: "-0.01em" }}>
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
        )}
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
