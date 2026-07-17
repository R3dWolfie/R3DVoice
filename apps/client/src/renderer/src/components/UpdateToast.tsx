import { useEffect, useState, type ReactElement } from "react";

const KEY = "r3dvoice.lastSeenVersion";

export function UpdateToast(): ReactElement | null {
  const [version, setVersion] = useState<string | null>(null);
  const [show, setShow] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const current = await window.r3dvoice.getAppVersion();
      if (cancelled) return;
      const lastSeen = localStorage.getItem(KEY);
      if (lastSeen === null) {
        // First install — don't show, just record the baseline.
        localStorage.setItem(KEY, current);
        return;
      }
      if (lastSeen !== current) {
        setVersion(current);
        setShow(true);
      }
    })();
    return () => { cancelled = true; };
  }, []);

  const dismiss = (): void => {
    if (version) localStorage.setItem(KEY, version);
    setShow(false);
  };

  const openWhatsNew = (): void => {
    if (!version) return;
    void window.r3dvoice.openExternal(
      `https://github.com/R3dWolfie/R3DVoice/releases/tag/v${version}`,
    );
    localStorage.setItem(KEY, version);
    setShow(false);
  };

  if (!show || !version) return null;

  return (
    <div
      data-rv="update-toast"
      data-testid="update-toast"
      style={{
        position: "fixed",
        bottom: "var(--s-4)",
        right: "var(--s-4)",
        background: "var(--bg-elev)",
        border: "1px solid var(--border-soft)",
        borderRadius: "var(--r-md)",
        padding: "var(--s-3) var(--s-4)",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        boxShadow: "0 4px 12px rgba(0,0,0,0.2)",
        zIndex: 1000,
        fontSize: "var(--t-sm)",
      }}
    >
      <span>Updated to v{version}</span>
      <button
        type="button"
        className="rv-btn"
        data-variant="primary"
        data-rv="whatsnew"
        onClick={openWhatsNew}
        style={{ height: "1.7rem", fontSize: "var(--t-xs)" }}
      >
        See what's new
      </button>
      <button
        type="button"
        className="rv-btn"
        data-variant="ghost"
        data-rv="dismiss"
        onClick={dismiss}
        aria-label="Dismiss"
        style={{ height: "1.7rem", fontSize: "var(--t-xs)" }}
      >
        ×
      </button>
    </div>
  );
}
