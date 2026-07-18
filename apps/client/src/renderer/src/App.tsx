import { useEffect, useMemo, useState, type ReactElement } from "react";
import { AuthProvider, useAuthStore, useNeedsHandle, useNeedsEmailVerify } from "./lib/auth-context.js";
import { usePrefs } from "./lib/prefs-singleton.js";
import { getRoomsStore, useRoomsStore } from "./lib/rooms-singleton.js";
import { buildJoinSelection } from "./lib/join-selection.js";
import { InRoomScreen } from "./screens/InRoomScreen.js";
import { applyThemeOverrides } from "./lib/theme-tokens.js";
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
import { UpdateGate } from "./components/UpdateGate.js";
import { InviteQueue } from "./components/InviteQueue.js";
import { DiagnosticsOverlay } from "./components/DiagnosticsOverlay.js";
import { startTelemetry } from "./lib/telemetry.js";
import { PasswordResetScreen } from "./screens/PasswordResetScreen.js";
import { VerifyEmailGate } from "./components/VerifyEmailGate.js";

function Router({ topPage, setTopPage }: { topPage: TopPage; setTopPage: (p: TopPage) => void }): ReactElement {
  const status = useAuthStore((s) => s.status);
  const needsHandle = useNeedsHandle();
  const needsEmailVerify = useNeedsEmailVerify();
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
  const [pendingDmUserId, setPendingDmUserId] = useState<string | null>(null);
  const [settingsOpen, setSettingsOpen] = useState(false);

  // Persistent call (#35): the shared rooms store owns activeRoomId, so the
  // in-room screen mounts here at shell level and survives navigation. When the
  // user browses another page mid-call it collapses to a floating mini bar
  // instead of tearing the connection down.
  const roomsStore = getRoomsStore(serverUrl, token);
  const activeRoomId = useRoomsStore(roomsStore, (s) => s.activeRoomId);
  const [callMinimized, setCallMinimized] = useState(false);
  // A fresh join (or a leave) always resets to the full call view.
  useEffect(() => {
    setCallMinimized(false);
  }, [activeRoomId]);
  const joinMicDeviceId = usePrefs((s) => s.micDeviceId);
  const joinSpeakerDeviceId = usePrefs((s) => s.speakerDeviceId);
  const joinResolution = usePrefs((s) => s.resolution);
  const joinFrameRate = usePrefs((s) => s.frameRate);
  // Freeze the join selection for the lifetime of one call: it must rebuild
  // only when activeRoomId flips, never when a device/quality pref changes
  // mid-call — the in-room join effect keys on this object and a new reference
  // would tear down and rejoin the live call.
  const callSelection = useMemo(
    () =>
      activeRoomId
        ? buildJoinSelection({
            micDeviceId: joinMicDeviceId,
            speakerDeviceId: joinSpeakerDeviceId,
            resolution: joinResolution,
            frameRate: joinFrameRate,
          })
        : null,
    // eslint-disable-next-line react-hooks/exhaustive-deps -- capture prefs once per call, keyed on activeRoomId
    [activeRoomId],
  );

  // Password-reset deep link (1.7): emailed as APP_URL/reset?token=… and
  // opened in the web client. Takes over the whole shell until dismissed.
  const [resetToken, setResetToken] = useState<string | null>(() => {
    try {
      const u = new URL(window.location.href);
      return u.pathname.replace(/\/$/, "") === "/reset" ? u.searchParams.get("token") : null;
    } catch {
      return null;
    }
  });

  // Listen for invite deep links from the main process.
  useEffect(() => {
    const off = window.r3dvoice.onInviteCode((code: string) => setPendingInviteCode(code));
    return off;
  }, []);

  if (resetToken) {
    return (
      <PasswordResetScreen
        token={resetToken}
        onDone={() => {
          setResetToken(null);
          try {
            window.history.replaceState({}, "", "/");
          } catch {
            /* ignore (desktop) */
          }
        }}
      />
    );
  }

  // Full-screen loader ONLY for the initial hydrate. Later "loading" states
  // (login attempts) must keep LoginScreen mounted or its fields are wiped
  // on failure (live QA finding).
  const [settledOnce, setSettledOnce] = useState(false);
  useEffect(() => {
    if (status !== "loading") setSettledOnce(true);
  }, [status]);
  if (status === "loading" && !settledOnce) {
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
    if (needsEmailVerify) {
      return <VerifyEmailGate />;
    }
    if (needsHandle) {
      return <HandlePickGate />;
    }
    // Navigating while in a call must not end it — collapse to the mini bar.
    const goPage = (p: TopPage): void => {
      if (activeRoomId) setCallMinimized(true);
      setTopPage(p);
    };
    return (
      <div style={{ display: "flex", height: "100%" }}>
        <LeftIconColumn
          active={topPage}
          onNavigate={goPage}
          onOpenSettings={() => setSettingsOpen(true)}
          onJoinRoom={(roomId) => {
            setPendingJoinRoomId(roomId);
            setTopPage("lobby");
          }}
        />
        <div style={{ flex: 1, minWidth: 0, position: "relative" }}>
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
              onOpenDms={(userId) => {
                setPendingDmUserId(userId ?? null);
                setTopPage("dms");
              }}
            />
          ) : (
            <DmsScreen
              onJoinRoom={(roomId) => {
                setPendingJoinRoomId(roomId);
                setTopPage("lobby");
              }}
              openUserId={pendingDmUserId}
              onOpenUserConsumed={() => setPendingDmUserId(null)}
            />
          )}
          {/* Persistent call (#35): stays mounted across page switches. Full
              view is an overlay covering the content area (not the rail); when
              minimized it renders only its floating mini bar. Never unmounted
              by navigation — only by leaving, which clears activeRoomId. */}
          {activeRoomId && callSelection && (
            <div
              style={
                callMinimized
                  ? undefined
                  : { position: "absolute", inset: 0, zIndex: 30, background: "var(--bg)" }
              }
            >
              <InRoomScreen
                roomId={activeRoomId}
                selection={callSelection}
                minimized={callMinimized}
                onRestore={() => setCallMinimized(false)}
                onLeave={() => {
                  roomsStore.getState().clearActive();
                  setCallMinimized(false);
                }}
              />
            </div>
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
    <UpdateGate serverUrl={serverUrl}>
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
    </UpdateGate>
  );
}

export function App(): ReactElement {
  useEffect(() => {
    const k = prefsActions().pttKeybind;
    if (k) void window.r3dvoice.setPttKeybind(k);
  }, []);

  // UX telemetry (measure "laggy / unresponsive" as numbers). Start the
  // collectors once; toggle the live HUD with Ctrl+Shift+D or Settings.
  const showDiagnostics = usePrefs((s) => s.showDiagnostics);
  useEffect(() => {
    startTelemetry();
    const onKey = (e: KeyboardEvent): void => {
      if (e.ctrlKey && e.shiftKey && (e.key === "D" || e.key === "d")) {
        e.preventDefault();
        prefsActions().setShowDiagnostics(!prefsActions().showDiagnostics);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Theme (3.6): light is the deck default; dark/grey apply via
  // data-theme on <html>; "system" tracks the OS live.
  const theme = usePrefs((s) => s.theme);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const apply = (): void => {
      const dark = theme === "dark" || (theme === "system" && mq.matches);
      if (dark) document.documentElement.setAttribute("data-theme", "dark");
      else if (theme === "grey") document.documentElement.setAttribute("data-theme", "grey");
      else document.documentElement.removeAttribute("data-theme");
    };
    apply();
    if (theme !== "system") return;
    mq.addEventListener("change", apply);
    return () => mq.removeEventListener("change", apply);
  }, [theme]);

  // 3.6 token editor — saved per-token overrides ride on top of the preset
  // as inline custom properties on <html>; reapplied on boot + when saved.
  const themeOverrides = usePrefs((s) => s.themeOverrides);
  useEffect(() => {
    applyThemeOverrides(themeOverrides);
  }, [themeOverrides]);

  return (
    <AuthProvider>
      <Chrome />
      <DiagnosticsOverlay open={showDiagnostics} />
    </AuthProvider>
  );
}
