import { useCallback, useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { MuteLevel } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";

type Props = {
  threadType: "room" | "dm";
  threadId: string;
  title: string;
  subtitle?: string | undefined;
  /** Extra header buttons (e.g. the 2.4e split-view ⫼ toggle). */
  actions?: ReactNode;
  /** Makes the title clickable (2.4a peer profile popover). */
  onTitleClick?: () => void;
};

export function ThreadHeader({ threadType, threadId, title, subtitle, actions, onTitleClick }: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [level, setLevel] = useState<MuteLevel>("all");
  const [busy, setBusy] = useState(false);

  // Pull the persisted mute level so the dropdown reflects reality on open.
  // Without this it always defaults to "all" — confusing if the user
  // already muted the thread previously.
  useEffect(() => {
    let cancelled = false;
    if (!token) return;
    const api = new ApiClient(serverUrl); api.setToken(token);
    void api.getMute(threadType, threadId).then((r) => {
      if (!cancelled) setLevel(r.level);
    }).catch(() => { /* default "all" if fetch fails */ });
    return () => { cancelled = true; };
  }, [serverUrl, token, threadType, threadId]);

  const setMute = useCallback(async (next: MuteLevel) => {
    setBusy(true);
    const api = new ApiClient(serverUrl); api.setToken(token);
    try {
      await api.setMute(threadType, threadId, next);
      getTransport()?.invalidateMute(threadType, threadId);
      setLevel(next);
    } finally { setBusy(false); }
  }, [serverUrl, token, threadType, threadId]);

  return (
    <header style={{ padding: "var(--s-3) var(--s-5)", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
      <div style={{ flex: 1 }}>
        {onTitleClick ? (
          <button
            type="button"
            onClick={onTitleClick}
            title="View profile"
            style={{
              appearance: "none",
              background: "transparent",
              border: 0,
              padding: 0,
              font: "inherit",
              fontWeight: 600,
              color: "var(--text)",
              cursor: "pointer",
              display: "inline-flex",
              alignItems: "center",
              gap: 4,
            }}
          >
            {title}
            <span style={{ fontSize: 9, color: "var(--text-dim)" }}>▾</span>
          </button>
        ) : (
          <div style={{ fontWeight: 600 }}>{title}</div>
        )}
        {subtitle && <div style={{ color: "var(--text-faint)", fontSize: "var(--t-sm)" }}>{subtitle}</div>}
      </div>
      <select
        className="rv-input"
        value={level}
        onChange={(e) => void setMute(e.target.value as MuteLevel)}
        disabled={busy}
        style={{ height: "1.8rem", fontSize: "var(--t-xs)", padding: "0 var(--s-2)" }}
      >
        <option value="all">All notifications</option>
        <option value="mentions">@mentions only</option>
        <option value="none">Muted</option>
      </select>
      {actions}
    </header>
  );
}
