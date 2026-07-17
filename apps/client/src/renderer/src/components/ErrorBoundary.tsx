import { Component, type ErrorInfo, type ReactNode } from "react";

// Crash page per WireFrames system/error-boundary.html: centered card,
// the error (mono), reload. Catches render-phase crashes so one broken
// component doesn't take the whole window to a white screen.
export class ErrorBoundary extends Component<
  { children: ReactNode },
  { error: Error | null }
> {
  override state: { error: Error | null } = { error: null };

  static getDerivedStateFromError(error: Error): { error: Error } {
    return { error };
  }

  override componentDidCatch(error: Error, info: ErrorInfo): void {
    try {
      void window.r3dvoice?.logError?.(
        `[error-boundary] ${error.message}\n${error.stack ?? ""}\ncomponentStack: ${info.componentStack ?? ""}`,
      );
    } catch {
      /* logging is best-effort */
    }
  }

  override render(): ReactNode {
    if (this.state.error === null) return this.props.children;
    return (
      <div
        style={{
          height: "100%",
          display: "grid",
          placeItems: "center",
          background: "var(--bg)",
          padding: "var(--s-7)",
        }}
      >
        <div className="rv-card" style={{ width: "min(94vw, 30rem)", textAlign: "center" }}>
          <div style={{ fontSize: "var(--t-xl)", fontWeight: 600, marginBottom: "var(--s-2)" }}>
            Something went wrong
          </div>
          <p style={{ margin: 0, marginBottom: "var(--s-4)", color: "var(--text-mid)", fontSize: "var(--t-sm)", lineHeight: 1.5 }}>
            The window hit an error it couldn't recover from. Reloading usually fixes it —
            if it keeps happening, tell Red what you clicked.
          </p>
          <div
            className="rv-mono rv-scroll"
            style={{
              textAlign: "left",
              fontSize: "var(--t-2xs)",
              color: "var(--text-dim)",
              background: "var(--bg-elev-2)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-sm)",
              padding: "var(--s-3)",
              marginBottom: "var(--s-4)",
              maxHeight: 120,
              overflow: "auto",
              wordBreak: "break-all",
            }}
          >
            {this.state.error.message}
          </div>
          <button
            className="rv-btn"
            data-variant="primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
        </div>
      </div>
    );
  }
}
