import { useEffect, useState, type ReactElement } from "react";
import { AuthProvider, useAuthStore, useNeedsHandle } from "./lib/auth-context.js";
import { usePrefs } from "./lib/prefs-singleton.js";
import { disconnectTransport, ensureTransport, setCurrentUserForNotifications } from "./lib/chat-transport.js";
import { ApiClient } from "./lib/api.js";
import { LoginScreen } from "./screens/LoginScreen.js";
import { LobbyScreen } from "./screens/LobbyScreen.js";
import { FriendsScreen } from "./screens/FriendsScreen.js";
import { HandlePickGate } from "./components/HandlePickGate.js";
import { prefsActions } from "./lib/prefs-singleton.js";
import { WindowChrome, Spinner } from "./components/Primitives.js";
import { LeftIconColumn, type TopPage } from "./components/LeftIconColumn.js";
import { DmsScreen } from "./screens/DmsScreen.js";
import { SettingsModal } from "./components/SettingsModal.js";
import { UpdateToast } from "./components/UpdateToast.js";
import { ToastHost } from "./components/ToastHost.js";
import { ConnectionBanner } from "./components/ConnectionBanner.js";
import { InviteQueue } from "./components/InviteQueue.js";

function Router({ topPage, setTopPage }: { topPage: TopPage; setTopPage: (p: TopPage) => void }): ReactElement {
  const status = useAuthStore((s) => s.status);
  const needsHandle = useNeedsHandle();
  const user = useAuthStore((s) => s.user);
  const token = useAuthStore((s) => s.token);
  const serverUrl = useAuthStore((s) => s.serverUrl);

  useEffect(() => {
    setCurrentUserForNotifications(user ?? null);
  }, [user]);

  // App-wide WS lifecycle. The transport must exist for the entire logged-in
  // session — otherwise WS-targeted events (mentions, friend requests,
  // invite redemptions, presence updates) silently drop whenever the user
  // isn't viewing a chat panel. Connect on auth, disconnect on logout.
  useEffect(() => {
    if (token && serverUrl) {
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      ensureTransport(serverUrl, token, api);
      return () => {
        // Don't disconnect on every re-render — only on actual logout
        // (token cleared). The next branch handles that.
      };
    }
    disconnectTransport();
    return undefined;
  }, [token, serverUrl]);

  const [pendingInviteCode, setPendingInviteCode] = useState<string | null>(() => {
    try {
      const u = new URL(window.location.href);
      return u.searchParams.get("invite");
    } catch {
      return null;
    }
  });
  const [pendingJoinRoomId, setPendingJoinRoomId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Listen for invite deep links from the main process.
  useEffect(() => {
    const off = window.r3dvoice.onInviteCode((code: string) => setPendingInviteCode(code));
    return off;
  }, []);

  if (status === "loading") {
    return (
      <div style={{ display: "grid", placeItems: "center", height: "100%", gap: "var(--s-3)" }}>
        <Spinner />
        <span
          style={{
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-xs)",
            letterSpacing: ".18em",
            textTransform: "uppercase",
            color: "var(--text-mid)",
          }}
        >
          Loading…
        </span>
      </div>
    );
  }
  if (status === "authenticated") {
    if (needsHandle) {
      return <HandlePickGate />;
    }
    return (
      <div style={{ display: "flex", height: "100%" }}>
        <LeftIconColumn
          active={topPage}
          onNavigate={setTopPage}
          onOpenSettings={() => setSettingsOpen(true)}
          onJoinRoom={(roomId) => {
            setPendingJoinRoomId(roomId);
            setTopPage("lobby");
          }}
        />
        <div style={{ flex: 1, minWidth: 0 }}>
          {topPage === "lobby" ? (
            <LobbyScreen
              pendingInviteCode={pendingInviteCode}
              pendingJoinRoomId={pendingJoinRoomId}
              onInviteCodeConsumed={() => {
                setPendingInviteCode(null);
                try {
                  const u = new URL(window.location.href);
                  u.searchParams.delete("invite");
                  window.history.replaceState({}, "", u.toString());
                } catch {
                  // ignore
                }
              }}
              onJoinRoomIdConsumed={() => setPendingJoinRoomId(null)}
              onInviteCode={(code) => setPendingInviteCode(code)}
              onOpenDms={() => setTopPage("dms")}
            />
          ) : topPage === "friends" ? (
            <FriendsScreen
              onJoinRoom={(roomId) => {
                setPendingJoinRoomId(roomId);
                setTopPage("lobby");
              }}
              onOpenDms={() => setTopPage("dms")}
            />
          ) : (
            <DmsScreen
              onJoinRoom={(roomId) => {
                setPendingJoinRoomId(roomId);
                setTopPage("lobby");
              }}
            />
          )}
        </div>
        {settingsOpen && <SettingsModal onClose={() => setSettingsOpen(false)} />}
        <UpdateToast />
        {/* 4.3 — corner queue for directed room invites arriving live. */}
        <InviteQueue
          onJoinRoom={(roomId) => {
            setPendingJoinRoomId(roomId);
            setTopPage("lobby");
          }}
        />
      </div>
    );
  }
  return <LoginScreen />;
}

function Chrome(): ReactElement {
  const status = useAuthStore((s) => s.status);
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const [topPage, setTopPage] = useState<TopPage>("lobby");
  const chromeTitle =
    status === "authenticated"
      ? `R3DVOICE · ${topPage === "dms" ? "DMS" : topPage === "friends" ? "FRIENDS" : "LOBBY"}`
      : status === "loading"
        ? "R3DVOICE · LOADING"
        : status === "totp-required"
          ? "R3DVOICE · 2FA"
          : "R3DVOICE · LOGIN";
  let serverLabel: string | undefined;
  try {
    serverLabel = new URL(serverUrl).host;
  } catch {
    serverLabel = serverUrl || undefined;
  }

  return (
    <WindowChrome title={chromeTitle} serverLabel={serverLabel}>
      <div style={{ display: "flex", flexDirection: "column", minHeight: 0, height: "100%" }}>
        {/* App-wide connection banner slot, directly under the titlebar
            (system/connection-banners.html) — renders nothing when healthy. */}
        <ConnectionBanner />
        <div key={status} className="rv-fade-in" style={{ flex: 1, minHeight: 0 }}>
          <Router topPage={topPage} setTopPage={setTopPage} />
        </div>
      </div>
      <ToastHost />
    </WindowChrome>
  );
}

export function App(): ReactElement {
  useEffect(() => {
    const k = prefsActions().pttKeybind;
    if (k) void window.r3dvoice.setPttKeybind(k);
  }, []);

  // Theme (3.6): light is the deck default; dark applies via
  // data-theme="dark" on <html>; "system" tracks the OS live.
  const theme = usePrefs((s) => s.theme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      if (dark) document.documentElement.setAttribute("data-theme", "dark");
      else document.documentElement.removeAttribute("data-theme");
    };
    apply();
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  return (
    <AuthProvider>
      <Chrome />
    </AuthProvider>
  );
}
