import { useEffect, useState, type ReactElement, type ReactNode } from "react";
import { useAuthStore } from "../lib/auth-context.js";
import { Avatar } from "./Avatar.js";
import { I } from "./Icons.js";
import { UserPanelPopover } from "./UserPanelPopover.js";
import { NotificationsPanel } from "./NotificationsPanel.js";
import { UnreadDot } from "./UnreadDot.js";
import { useUnreadStore } from "../lib/unread-store.js";
import {
  useNotificationsStore,
  unseenCount,
  wireNotificationsToTransport,
  configureNotificationsApi,
} from "../lib/notifications-store.js";
import { ApiClient } from "../lib/api.js";

export type TopPage = "lobby" | "dms" | "friends";

type Props = {
  active: TopPage;
  onNavigate(page: TopPage): void;
  onOpenSettings(): void;
  /** Directed-invite Join action (4.15): route into a room via the lobby. */
  onJoinRoom?(roomId: string): void;
};

function NavIcon({
  active,
  onClick,
  ariaLabel,
  children,
}: {
  active: boolean;
  onClick(): void;
  ariaLabel: string;
  children: ReactNode;
}): ReactElement {
  return (
    <button
      type="button"
      aria-label={ariaLabel}
      title={ariaLabel}
      onClick={onClick}
      style={{
        width: 40, height: 40,
        display: "grid", placeItems: "center",
        borderRadius: "var(--r-md)",
        background: active ? "color-mix(in oklch, var(--accent) 22%, transparent)" : "transparent",
        border: active ? "1px solid var(--accent)" : "1px solid transparent",
        color: active ? "var(--accent)" : "var(--text-mid)",
        cursor: "pointer",
        transition: "background var(--d-fast), color var(--d-fast)",
      }}
    >
      {children}
    </button>
  );
}

export function LeftIconColumn({ active, onNavigate, onOpenSettings, onJoinRoom }: Props): ReactElement {
  const me = useAuthStore((s) => s.user);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const logout = useAuthStore((s) => s.logout);
  const [userPanelOpen, setUserPanelOpen] = useState(false);
  const [bellOpen, setBellOpen] = useState(false);
  const totalUnread = useUnreadStore((s) => s.totalUnread);
  const bellCount = useNotificationsStore((s) => unseenCount(s));
  const notifLoaded = useNotificationsStore((s) => s.loaded);
  const notifRefresh = useNotificationsStore((s) => s.refresh);

  // Badge must be live before the panel is ever opened.
  useEffect(() => {
    configureNotificationsApi(() => {
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      return api;
    });
    wireNotificationsToTransport();
    if (!notifLoaded) void notifRefresh();
  }, [serverUrl, token, notifLoaded, notifRefresh]);

  return (
    <nav
      style={{
        width: 48,
        flexShrink: 0,
        background: "var(--bg)",
        borderRight: "1px solid var(--border-soft)",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        padding: "var(--s-3) 0",
        gap: "var(--s-2)",
      }}
    >
      <I.Logo size={22} />
      <div style={{ height: "var(--s-3)" }} />
      <NavIcon active={active === "lobby"} onClick={() => onNavigate("lobby")} ariaLabel="Home">
        <I.Home size={16} />
      </NavIcon>
      <div style={{ position: "relative" }}>
        <NavIcon active={active === "dms"} onClick={() => onNavigate("dms")} ariaLabel="Direct messages">
          <I.Chat size={16} />
        </NavIcon>
        {totalUnread > 0 && (
          <span style={{ position: "absolute", top: -4, right: -4, pointerEvents: "none" }}>
            <UnreadDot count={totalUnread} />
          </span>
        )}
      </div>
      <NavIcon active={active === "friends"} onClick={() => onNavigate("friends")} ariaLabel="Friends">
        <I.Users size={16} />
      </NavIcon>
      <div style={{ position: "relative" }}>
        <NavIcon active={bellOpen} onClick={() => setBellOpen((v) => !v)} ariaLabel="Notifications">
          <I.Bell size={16} />
        </NavIcon>
        {bellCount > 0 && (
          <span style={{ position: "absolute", top: -4, right: -4, pointerEvents: "none" }}>
            <UnreadDot count={bellCount} />
          </span>
        )}
        <NotificationsPanel
          open={bellOpen}
          onClose={() => setBellOpen(false)}
          onOpenDms={() => onNavigate("dms")}
          onOpenFriends={() => onNavigate("friends")}
          onJoinRoom={onJoinRoom}
          onOpenSettings={onOpenSettings}
        />
      </div>

      <div style={{ flex: 1 }} />

      {me && (
        <div style={{ position: "relative" }}>
          <button
            type="button"
            aria-label="Your account"
            title={me.handle ? `@${me.handle}` : me.displayName}
            onClick={() => setUserPanelOpen((v) => !v)}
            style={{
              width: 36, height: 36,
              borderRadius: "50%",
              border: "none",
              background: "transparent",
              cursor: "pointer",
              padding: 0,
              display: "grid", placeItems: "center",
            }}
          >
            <span style={{ position: "relative", display: "inline-flex" }}>
              <Avatar
                src={me.avatarUrl ?? null}
                fallbackInitials={me.displayName ?? ""}
                fallbackColorSeed={me.id}
                size={36}
              />
              {/* deck icon-col: presence dot on the me-avatar */}
              <span
                className="rv-status"
                style={{ position: "absolute", bottom: -1, right: -1, boxShadow: "0 0 0 2px var(--bg)" }}
              />
            </span>
          </button>
          <UserPanelPopover
            open={userPanelOpen}
            onClose={() => setUserPanelOpen(false)}
            displayName={me.displayName ?? "(you)"}
            handle={me.handle ?? null}
            onOpenSettings={onOpenSettings}
            onLogout={() => void logout()}
          />
        </div>
      )}
    </nav>
  );
}
