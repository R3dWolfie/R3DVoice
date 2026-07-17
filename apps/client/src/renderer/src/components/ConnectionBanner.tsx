import { useEffect, useState, type ReactElement } from "react";
import { useConnectionStore } from "../lib/connection-store.js";
import { getTransport } from "../lib/chat-transport.js";
import { Spinner } from "./Primitives.js";

function agoLabel(fromMs: number): string {
  const s = Math.max(0, Math.round((Date.now() - fromMs) / 1000));
  if (s < 60) return `${s}s ago`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  return `${Math.floor(m / 60)}h ago`;
}

/**
 * App-wide banner slot under the titlebar (system/connection-banners.html).
 * Nothing renders when healthy. Two degraded variants:
 *  - Reconnecting: spinner + "Reconnecting… · trying again in Ns" (auto).
 *  - Offline (browser offline or 3+ failed attempts): persistent, with a
 *    "Retry now" button that skips the backoff timer.
 */
export function ConnectionBanner(): ReactElement | null {
  const status = useConnectionStore((s) => s.status);
  const attempts = useConnectionStore((s) => s.attempts);
  const nextRetryAt = useConnectionStore((s) => s.nextRetryAt);
  const lastOpenAt = useConnectionStore((s) => s.lastOpenAt);

  // 1s tick to keep the countdown / "last sync" fresh while degraded.
  const [, setTick] = useState(0);
  useEffect(() => {
    if (status !== "reconnecting") return;
    const t = window.setInterval(() => setTick((n) => n + 1), 1000);
    return () => window.clearInterval(t);
  }, [status]);

  if (status !== "reconnecting") return null;

  const offline = !navigator.onLine || attempts >= 3;

  if (offline) {
    return (
      <div className="rv-banner" data-tone="error" role="alert">
        <span style={{ color: "var(--danger)", fontSize: "var(--t-2xs)" }} aria-hidden>
          ●
        </span>
        <span>
          <b style={{ fontWeight: 600 }}>Offline.</b> Your messages won&apos;t send and your voice
          will drop.
          {lastOpenAt != null && ` Last sync ${agoLabel(lastOpenAt)}.`}
        </span>
        <button
          type="button"
          className="rv-btn"
          style={{ height: "1.6rem", padding: "0 var(--s-3)", fontSize: "var(--t-2xs)" }}
          onClick={() => getTransport()?.retryNow()}
        >
          Retry now
        </button>
      </div>
    );
  }

  const secs =
    nextRetryAt != null ? Math.max(0, Math.ceil((nextRetryAt - Date.now()) / 1000)) : null;
  return (
    <div className="rv-banner" data-tone="warn" role="status">
      <Spinner />
      <span>
        <b style={{ fontWeight: 600 }}>Reconnecting…</b>
        {secs != null && secs > 0 && ` · trying again in ${secs}s`}
      </span>
    </div>
  );
}
