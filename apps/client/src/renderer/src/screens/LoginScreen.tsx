import { useState, useEffect, type FormEvent, type ReactElement } from "react";
import { useAuthStore } from "../lib/auth-context.js";
import { usePrefs, prefsActions } from "../lib/prefs-singleton.js";
import { Field, Spinner, APP_VERSION } from "../components/Primitives.js";
import { I } from "../components/Icons.js";
import { parseKeyBackup, saveKeyPair, loadKeyPair } from "../lib/key-storage.js";

type Mode = "login" | "register";

// Auth screens per WireFrames 1.1 / 1.1a / 1.2 / 1.3: a single centered
// 24rem column — brand row, Sign in / Create account tabs, fields, CTA —
// with the build footer pinned to the window edge. The server picker is
// gone from this screen (deck: centralized identity); the URL still
// hydrates from prefs and stays editable under Settings.
export function LoginScreen(): ReactElement {
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [displayName, setDisplayName] = useState("");

  const prefsServerUrl = usePrefs((s) => s.serverUrl);
  const setServerUrl = useAuthStore((s) => s.setServerUrl);
  const [serverEditOpen, setServerEditOpen] = useState(false);

  // Hydrate in-memory auth-store from persisted prefs on mount.
  useEffect(() => {
    setServerUrl(prefsServerUrl);
  }, [prefsServerUrl, setServerUrl]);

  const status = useAuthStore((s) => s.status);
  const error = useAuthStore((s) => s.error);
  const login = useAuthStore((s) => s.login);
  const register = useAuthStore((s) => s.register);
  const loginTotp = useAuthStore((s) => s.loginTotp);
  const cancelTotp = useAuthStore((s) => s.cancelTotp);
  const [totpCode, setTotpCode] = useState("");
  const [keyImportMessage, setKeyImportMessage] = useState<string | null>(null);

  const onImportKey = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const text = typeof reader.result === "string" ? reader.result : "";
      const kp = parseKeyBackup(text);
      if (!kp) {
        setKeyImportMessage("Couldn't parse — make sure it's the r3dvoice-key-*.json file you downloaded at registration.");
        return;
      }
      saveKeyPair(kp);
      setKeyImportMessage("Key restored. Sign in to decrypt your DM history.");
    };
    reader.onerror = () => setKeyImportMessage("Failed to read file.");
    reader.readAsText(file);
    e.target.value = "";
  };

  async function onSubmit(e: FormEvent): Promise<void> {
    e.preventDefault();
    if (status === "totp-required") {
      await loginTotp(totpCode);
      setTotpCode("");
      return;
    }
    if (mode === "login") {
      await login(email, password);
    } else {
      await register(email, password, displayName);
    }
  }

  const busy = status === "loading";
  const totpStep = status === "totp-required";

  return (
    // Grid centering, NOT transform centering — rv-fade-in's final keyframe
    // (transform: none, fill both) would permanently clobber a translate(-50%).
    <div
      style={{
        position: "relative",
        height: "100%",
        background: "var(--bg)",
        display: "grid",
        placeItems: "center",
      }}
    >
      <div
        style={{
          width: "min(92vw, 24rem)",
          display: "flex",
          flexDirection: "column",
        }}
        className="rv-fade-in"
      >
        {/* brand row */}
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: "var(--s-3)",
            marginBottom: "var(--s-7)",
          }}
        >
          <I.Logo size={22} />
          <span
            style={{
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-xs)",
              letterSpacing: ".25em",
              textTransform: "uppercase",
              fontWeight: 600,
            }}
          >
            R3DVOICE
          </span>
        </div>

        <form onSubmit={onSubmit} style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
          {!totpStep && (
            <div className="rv-tabs" role="tablist" style={{ gap: "var(--s-6)" }}>
              <button
                type="button"
                className="rv-tab"
                data-active={mode === "login"}
                onClick={() => setMode("login")}
              >
                Sign in
              </button>
              <button
                type="button"
                className="rv-tab"
                data-active={mode === "register"}
                onClick={() => setMode("register")}
              >
                Create account
              </button>
            </div>
          )}

          {error && (
            <div className="rv-err-banner" role="alert">
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          )}

          {!totpStep && mode === "register" && (
            <Field label="Display name">
              <input
                className="rv-input"
                type="text"
                required
                minLength={1}
                maxLength={50}
                value={displayName}
                onChange={(e) => setDisplayName(e.target.value)}
                placeholder="How you'll appear"
              />
            </Field>
          )}

          {!totpStep && (
            <Field label="Email">
              <input
                className="rv-input"
                type="email"
                autoComplete="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="you@example.com"
              />
            </Field>
          )}

          {!totpStep && (
            <Field label="Password">
              <input
                className="rv-input"
                type="password"
                autoComplete={mode === "login" ? "current-password" : "new-password"}
                required
                minLength={mode === "register" ? 12 : 1}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
              {mode === "register" && <div className="rv-field-help">At least 12 characters.</div>}
            </Field>
          )}

          {!totpStep && mode === "login" && (
            <button
              type="button"
              title="Password reset needs the email flows — coming once SMTP is wired."
              style={{
                alignSelf: "flex-end",
                appearance: "none",
                background: "transparent",
                border: 0,
                padding: 0,
                marginTop: "calc(var(--s-3) * -1)",
                font: "inherit",
                fontSize: "var(--t-xs)",
                color: "var(--text-dim)",
                textDecoration: "underline",
                textUnderlineOffset: 2,
                cursor: "default",
                opacity: 0.7,
              }}
            >
              Forgot password?
            </button>
          )}

          {totpStep && (
            <Field label="Two-factor code" hint="6 digits from your authenticator — or a backup code (XXXX-XXXX)">
              <input
                className="rv-input"
                type="text"
                autoComplete="one-time-code"
                maxLength={9}
                required
                autoFocus
                value={totpCode}
                onChange={(e) => setTotpCode(e.target.value.toUpperCase().replace(/[^A-Z0-9-]/g, ""))}
                placeholder="123456"
                style={{
                  fontFamily: "var(--font-mono)",
                  fontSize: "var(--t-xl)",
                  letterSpacing: "0.35em",
                  textAlign: "center",
                  height: "3rem",
                }}
              />
            </Field>
          )}

          <button
            className="rv-btn"
            data-variant="primary"
            type="submit"
            disabled={busy || (totpStep && !/^\d{6}$/.test(totpCode) && !/^[A-Z0-9]{4}-?[A-Z0-9]{4}$/.test(totpCode))}
            style={{ height: "2.75rem", marginTop: "var(--s-1)" }}
          >
            {busy ? (
              <>
                <Spinner /> {totpStep ? "Verifying…" : "Connecting…"}
              </>
            ) : totpStep ? (
              <>
                Verify <I.Chevron size={16} />
              </>
            ) : (
              <>
                {mode === "login" ? "Sign in" : "Create account"} <I.Chevron size={16} />
              </>
            )}
          </button>

          {totpStep && (
            <button
              type="button"
              className="rv-btn"
              onClick={() => {
                setTotpCode("");
                cancelTotp();
              }}
            >
              Back to sign in
            </button>
          )}

          {!totpStep && (
            <>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--s-3)",
                  color: "var(--text-faint)",
                  fontSize: "var(--t-2xs)",
                  fontFamily: "var(--font-mono)",
                  letterSpacing: ".2em",
                  textTransform: "uppercase",
                }}
              >
                <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
                session restored from os keychain
                <span style={{ flex: 1, height: 1, background: "var(--border-soft)" }} />
              </div>

              {/* E2EE key import — shows on new devices where the user already has
                  an account from elsewhere and needs to restore their backup. */}
              {mode === "login" && !loadKeyPair() && (
                <label
                  style={{
                    textAlign: "center",
                    fontSize: "var(--t-sm)",
                    color: "var(--text-mid)",
                    cursor: "pointer",
                  }}
                >
                  <input type="file" accept="application/json,.json" onChange={onImportKey} style={{ display: "none" }} />
                  <span style={{ color: "var(--text)", textDecoration: "underline", textUnderlineOffset: 3 }}>
                    Restore E2EE key backup…
                  </span>
                </label>
              )}
              {keyImportMessage && (
                <div
                  style={{
                    fontSize: "var(--t-xs)",
                    color: "var(--text-mid)",
                    padding: "var(--s-2) var(--s-3)",
                    border: "1px solid var(--border-soft)",
                    borderRadius: "var(--r-sm)",
                    background: "var(--bg-elev-2)",
                  }}
                >
                  {keyImportMessage}
                </div>
              )}
            </>
          )}
        </form>
      </div>

      {/* footer pinned to the window edge — "self-hostable" doubles as the
          server-URL escape hatch (the deck removed the login server picker;
          self-hosters and dev still need a pre-auth way to point elsewhere) */}
      <div
        style={{
          position: "absolute",
          left: 0,
          right: 0,
          bottom: 0,
          padding: "var(--s-4) var(--s-6)",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          gap: "var(--s-3)",
        }}
      >
        {serverEditOpen && (
          <input
            autoFocus
            className="rv-input"
            value={prefsServerUrl}
            spellCheck={false}
            onChange={(e) => {
              const normalized = e.target.value.replace(/\\/g, "/");
              prefsActions().setServerUrl(normalized);
              setServerUrl(normalized);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === "Escape") setServerEditOpen(false);
            }}
            placeholder="https://voice.r3dwolfie.com"
            style={{ width: "min(92vw, 20rem)", height: "2rem", fontSize: "var(--t-xs)", fontFamily: "var(--font-mono)" }}
          />
        )}
        <div
          style={{
            display: "flex",
            justifyContent: "center",
            alignItems: "center",
            gap: "var(--s-3)",
            fontFamily: "var(--font-mono)",
            fontSize: "var(--t-2xs)",
            letterSpacing: ".2em",
            textTransform: "uppercase",
            color: "var(--text-dim)",
          }}
        >
          <span>build · v{APP_VERSION}</span>
          <span style={{ color: "var(--text-faint)" }}>·</span>
          <button
            type="button"
            onClick={() => setServerEditOpen((v) => !v)}
            title={`Server: ${prefsServerUrl} — click to change`}
            style={{
              appearance: "none",
              background: "transparent",
              border: 0,
              padding: 0,
              font: "inherit",
              letterSpacing: "inherit",
              textTransform: "inherit",
              color: "inherit",
              cursor: "pointer",
              textDecoration: serverEditOpen ? "underline" : "none",
              textUnderlineOffset: 3,
            }}
          >
            self-hostable
          </button>
          <span style={{ color: "var(--text-faint)" }}>·</span>
          <span>AGPL</span>
        </div>
      </div>
    </div>
  );
}
