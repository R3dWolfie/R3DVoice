import { useEffect, useRef, type ReactElement } from "react";
import { useToastStore, type ToastItem } from "../lib/toast-store.js";

// Deck glyphs (system/toasts.html): ✓ success · ↺ undo · ● info · ⚠ warn · ✕ error
const GLYPH: Record<ToastItem["kind"], string> = {
  success: "✓",
  undo: "↺",
  info: "●",
  warn: "⚠",
  error: "✕",
};

function toneFor(kind: ToastItem["kind"]): "success" | "warn" | "error" | undefined {
  if (kind === "success") return "success";
  if (kind === "warn") return "warn";
  if (kind === "error") return "error";
  return undefined; // info / undo use the neutral card
}

function ToastCard({ toast }: { toast: ToastItem }): ReactElement {
  const dismiss = useToastStore((s) => s.dismiss);
  // Auto-dismiss with hover-pause: the timer stops while the pointer is over
  // the card and resumes with the remaining time on leave.
  const timerRef = useRef<number | null>(null);
  const remainingRef = useRef(toast.durationMs);
  const startedAtRef = useRef(0);

  useEffect(() => {
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => dismiss(toast.id), remainingRef.current);
    return () => {
      if (timerRef.current != null) window.clearTimeout(timerRef.current);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [toast.id]);

  const pause = (): void => {
    if (timerRef.current == null) return;
    window.clearTimeout(timerRef.current);
    timerRef.current = null;
    remainingRef.current = Math.max(800, remainingRef.current - (Date.now() - startedAtRef.current));
  };
  const resume = (): void => {
    if (timerRef.current != null) return;
    startedAtRef.current = Date.now();
    timerRef.current = window.setTimeout(() => dismiss(toast.id), remainingRef.current);
  };

  return (
    <div
      className="rv-toast"
      data-tone={toneFor(toast.kind)}
      role="status"
      onMouseEnter={pause}
      onMouseLeave={resume}
    >
      <span className="rv-toast-ic" aria-hidden>
        {GLYPH[toast.kind]}
      </span>
      <div className="rv-toast-text">
        <div className="rv-toast-title">{toast.text}</div>
        {toast.sub && <div className="rv-toast-sub">{toast.sub}</div>}
      </div>
      {toast.action && (
        <button
          type="button"
          className="rv-toast-action"
          onClick={() => {
            toast.action?.onAction();
            dismiss(toast.id);
          }}
        >
          {toast.action.label}
        </button>
      )}
      <button
        type="button"
        className="rv-toast-close"
        aria-label="Dismiss"
        onClick={() => dismiss(toast.id)}
      >
        ×
      </button>
    </div>
  );
}

/** Mounted once in App. Renders the bottom-right toast stack, newest-on-top. */
export function ToastHost(): ReactElement | null {
  const toasts = useToastStore((s) => s.toasts);
  if (toasts.length === 0) return null;
  return (
    <div className="rv-toast-host" aria-live="polite">
      {toasts.map((t) => (
        <ToastCard key={t.id} toast={t} />
      ))}
    </div>
  );
}
