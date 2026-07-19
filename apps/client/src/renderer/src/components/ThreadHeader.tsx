import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import type { MuteLevel } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { MutePopover } from "./MutePopover.js";

type Props = {
  threadType: "room" | "dm";
  threadId: string;
  title: string;
  subtitle?: string | undefined;
  /** Extra header buttons (e.g. the 2.4e split-view ⫼ toggle). */
  actions?: ReactNode;
  /** Makes the title clickable (2.4a peer profile popover). */
  onTitleClick?: () => void;
  /** Leading node - the peer avatar in DM headers (2.4). */
  leading?: ReactNode;
  /** Inline badge next to the title (deck: the 🔒 E2EE pill). */
  badge?: ReactNode;
};

export function ThreadHeader({ threadType, threadId, title, subtitle, actions, onTitleClick, leading, badge }: Props): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [level, setLevel] = useState<MuteLevel>("all");
  const [muteMenuOpen, setMuteMenuOpen] = useState(false);

  // Pull the persisted mute level so the bell reflects reality on open.
  // Without this it always defaults to "all" - confusing if the user
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

  return (
    <header style={{ padding: "var(--s-3) var(--s-5)", borderBottom: "1px solid var(--border-soft)", display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
      {leading}
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
            {badge}
          </button>
        ) : (
          <div style={{ fontWeight: 600 }}>{title}</div>
        )}
        {subtitle && <div style={{ color: "var(--text-faint)", fontSize: "var(--t-sm)" }}>{subtitle}</div>}
      </div>
      {/* 2.4b - compact mute icon; levels + duration live in the timed-mute
          popover (1h/3h/8h/24h/∞), not a full-width native select. */}
      <div style={{ position: "relative" }}>
        <button
          type="button"
          className="rv-btn rv-btn-icon"
          data-variant="ghost"
          data-active={level !== "all" || muteMenuOpen}
          title={level === "all" ? "Notifications: all" : level === "mentions" ? "Notifications: @mentions only" : "Muted"}
          onClick={() => setMuteMenuOpen((v) => !v)}
          style={{ height: "1.8rem", width: "1.8rem", fontSize: 14, color: level === "none" ? "var(--rv-amber)" : undefined }}
        >
          {level === "none" ? "🔕" : level === "mentions" ? "＠" : "🔔"}
        </button>
        {muteMenuOpen && (
          <MutePopover
            threadType={threadType}
            threadId={threadId}
            targetLabel={subtitle?.startsWith("@") ? subtitle : title}
            onClose={() => setMuteMenuOpen(false)}
            onChanged={(next) => setLevel(next)}
          />
        )}
      </div>
      {actions}
    </header>
  );
}
