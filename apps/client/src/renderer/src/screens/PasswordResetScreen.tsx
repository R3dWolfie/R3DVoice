import { useState, type FormEvent, type ReactElement } from "react";
import { usePrefs } from "../lib/prefs-singleton.js";
import { ApiClient, ApiError } from "../lib/api.js";
import { Field, Spinner, APP_VERSION } from "../components/Primitives.js";
import { I } from "../components/Icons.js";

// WireFrames 1.7 — "Set a new password". Reached pre-auth via the emailed
// reset link (voice.r3dwolfie.com/reset?token=…). On success it clears the
// token from the URL and hands back to the sign-in screen.
export function PasswordResetScreen({ token, onDone }: { token: string; onDone: () => void }): ReactElement {
  const serverUrl = usePrefs((s) => s.serverUrl);
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const tooShort = password.length > 0 && password.length < 12;
  const mismatch = confirm.length > 0 && confirm !== password;
  const canSubmit = password.length >= 12 && confirm === password && !busy;

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (!canSubmit) return;
    setBusy(true);
    setError(null);
    try {
      const api = new ApiClient(serverUrl);
      await api.confirmPasswordReset(token, password);
      setDone(true);
    } catch (err) {
      setError(
        err instanceof ApiError
          ? err.message
          : "Couldn't reset your password — the link may have expired.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ position: "relative", height: "100%", background: "var(--bg)", display: "grid", placeItems: "center" }}>
      <div style={{ width: "min(92vw, 24rem)", display: "flex", flexDirection: "column" }}>
        <div style={{ display: "flex", alignItems: "center", justifyContent: "center", gap: "var(--s-3)", marginBottom: "var(--s-7)" }}>
          <I.Logo size={22} />
          <span style={{ fontFamily: "var(--font-mono)", fontSize: "var(--t-xs)", letterSpacing: ".25em", textTransform: "uppercase", fontWeight: 600 }}>
            R3DVOICE
          </span>
        </div>

        {done ? (
          <div style={{ textAlign: "center", display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
            <div>
              <div style={{ fontSize: "40px", marginBottom: "var(--s-2)" }}>✓</div>
              <div style={{ fontSize: "var(--t-xl)", fontWeight: 600, marginBottom: "var(--s-2)" }}>Password updated</div>
              <div style={{ fontSize: "var(--t-sm)", color: "var(--text-mid)", lineHeight: 1.5 }}>
                You've been signed out everywhere. Sign in with your new password.
              </div>
            </div>
            <button className="rv-btn" data-variant="primary" onClick={onDone} style={{ height: "2.5rem" }}>
              Back to sign in
            </button>
          </div>
        ) : (
          <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
            <div style={{ textAlign: "center", marginBottom: "var(--s-1)" }}>
              <div style={{ fontSize: "var(--t-xl)", fontWeight: 600 }}>Set a new password</div>
            </div>

            {error && (
              <div className="rv-err-banner" role="alert">
                <span className="ic">!</span>
                <div>{error}</div>
              </div>
            )}

            <Field label="New password">
              <input
                className="rv-input"
                type="password"
                autoComplete="new-password"
                required
                autoFocus
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              <div className="rv-field-help" style={tooShort ? { color: "var(--danger)" } : undefined}>
                At least 12 characters.
              </div>
            </Field>

            <Field label="Confirm password">
              <input
                className="rv-input"
                type="password"
                autoComplete="new-password"
                required
                value={confirm}
                onChange={(e) => setConfirm(e.target.value)}
              />
              {mismatch && <div className="rv-field-help" style={{ color: "var(--danger)" }}>Passwords don't match.</div>}
            </Field>

            <button className="rv-btn" data-variant="primary" type="submit" disabled={!canSubmit} style={{ height: "2.75rem" }}>
              {busy ? (
                <>
                  <Spinner /> Resetting…
                </>
              ) : (
                "Reset password"
              )}
            </button>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={onDone} style={{ height: "2.25rem" }}>
              Back to sign in
            </button>
          </form>
        )}
      </div>

      <div style={{ position: "absolute", left: 0, right: 0, bottom: 0, padding: "var(--s-4) var(--s-6)", display: "flex", justifyContent: "center", fontFamily: "var(--font-mono)", fontSize: "var(--t-2xs)", letterSpacing: ".2em", textTransform: "uppercase", color: "var(--text-dim)" }}>
        <span>build · v{APP_VERSION} · self-hostable · AGPL</span>
      </div>
    </div>
  );
}
