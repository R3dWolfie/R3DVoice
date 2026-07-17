import { useEffect, useState, type ReactElement } from "react";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { Spinner, APP_VERSION } from "./Primitives.js";
import { I } from "./Icons.js";

// WireFrames 1.5 — email verification gate. Shown when authenticated but the
// server reports the address is unverified. The session exists (so we can
// resend and poll), but the app is withheld behind this screen. Escape hatch:
// Sign out. Poll /me every 4s so clicking the emailed link in another tab
// drops the user straight in without a manual refresh.
export function VerifyEmailGate(): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const logout = useAuthStore((s) => s.logout);
  const refreshUser = useAuthStore((s) => s.refreshUser);

  const [cooldown, setCooldown] = useState(0);
  const [sending, setSending] = useState(false);
  const [note, setNote] = useState<string | null>(null);

  const apiFor = (): ApiClient => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  };

  // Poll for verification landing (link clicked elsewhere).
  useEffect(() => {
    const t = setInterval(() => void refreshUser(), 4000);
    return () => clearInterval(t);
  }, [refreshUser]);

  // Resend cooldown ticker.
  useEffect(() => {
    if (cooldown <= 0) return;
    const t = setInterval(() => setCooldown((c) => Math.max(0, c - 1)), 1000);
    return () => clearInterval(t);
  }, [cooldown]);

  const resend = async (): Promise<void> => {
    if (cooldown > 0 || sending) return;
    setSending(true);
    setNote(null);
    try {
      await apiFor().resendVerificationEmail();
      setNote("Sent — check your inbox.");
      setCooldown(30);
    } catch {
      setNote("Couldn't resend just now. Try again in a moment.");
    } finally {
      setSending(false);
    }
  };

  return (
    <div style={{ position: "relative", height: "100%", background: "var(--bg)", display: "grid", placeItems: "center" }}>
      <div style={{ width: "min(92vw, 24rem)", display: "flex", flexDirection: "column", alignItems: "center", textAlign: "center", gap: "var(--s-5)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
          <I.Logo size={22} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-xs)", letterSpacing: ".25em", textTransform: "uppercase", fontWeight: 600 }}>
            R3DVOICE
          </span>
        </div>

        <div>
          <div style={{ fontSize: "var(--t-xl)", fontWeight: 600, marginBottom: "var(--s-2)" }}>Verify your email</div>
          <div style={{ fontSize: "var(--t-sm)", color: "var(--text-mid)", lineHeight: 1.5 }}>
            Click the link we just sent{" "}
            <span style={{ color: "var(--text)", fontWeight: 600 }}>{user?.email}</span>.
          </div>
          <div style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)", marginTop: "var(--s-3)" }}>
            Don't see it? Check your spam folder. Mail can take ~1 minute.
          </div>
        </div>

        <div style={{ width: "100%", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
          <button
            className="rv-btn"
            data-variant="primary"
            disabled={cooldown > 0 || sending}
            onClick={() => void resend()}
            style={{ height: "2.5rem" }}
          >
            {sending ? (
              <>
                <Spinner /> Sending…
              </>
            ) : cooldown > 0 ? (
              `Resend in ${cooldown}s`
            ) : (
              "Resend email"
            )}
          </button>
          {note && <div style={{ fontSize: "var(--t-xs)", color: "var(--text-mid)" }}>{note}</div>}
          <button className="rv-btn" data-variant="ghost" onClick={() => void logout()} style={{ height: "2.25rem" }}>
            Sign out
          </button>
        </div>
      </div>

      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "var(--s-4) var(--s-6)", display: "flex", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: "var(--t-2xs)", letterSpacing: ".2em", textTransform: "uppercase", color: "var(--text-dim)" }}>
        <span>build · v{APP_VERSION} · self-hostable · AGPL</span>
      </div>
    </div>
  );
}
