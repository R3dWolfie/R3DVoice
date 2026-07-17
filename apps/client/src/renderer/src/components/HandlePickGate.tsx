import { useCallback, useEffect, useMemo, useState, type ReactElement } from "react";
import { userHandleSchema } from "@r3dvoice/shared";
import { Modal } from "./Modal.js";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";

const ADJECTIVES = [
  "cosmic", "crimson", "electric", "quiet", "rapid", "lunar", "amber",
  "velvet", "shadow", "prism", "static", "neon", "polar", "ember",
];
const NOUNS = [
  "otter", "wolf", "falcon", "moth", "fox", "raven", "lynx",
  "badger", "heron", "viper", "stoat", "koi", "newt", "crane",
];

function whimsicalHandle(): string {
  const a = ADJECTIVES[Math.floor(Math.random() * ADJECTIVES.length)];
  const n = NOUNS[Math.floor(Math.random() * NOUNS.length)];
  const num = Math.floor(Math.random() * 900) + 100;
  return `${a}_${n}_${num}`;
}

// Mirrors the server's slug rules (auth/handle-generator.ts).
function slugFromDisplayName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\s+/g, "_")
    .replace(/[^a-z0-9_]/g, "")
    .slice(0, 20);
}

// Handle-pick gate per WireFrames 1.4: pre-filled generated handle with an
// inline Reroll, click-to-type-your-own, live availability, footer band
// with the primary action. Not dismissible — the gate blocks the app.
export function HandlePickGate(): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const user = useAuthStore((s) => s.user);
  const refreshUser = useAuthStore((s) => s.refreshUser);

  const initial = useMemo(() => {
    const slug = slugFromDisplayName(user?.displayName ?? "");
    return slug.length >= 3 ? slug : whimsicalHandle();
  }, [user?.displayName]);

  const [value, setValue] = useState(initial);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [available, setAvailable] = useState<null | "checking" | "yes" | "no">(null);

  // Live availability check, debounced.
  useEffect(() => {
    if (!value) {
      setAvailable(null);
      setError(null);
      return;
    }
    const parsed = userHandleSchema.safeParse(value);
    if (!parsed.success) {
      setAvailable(null);
      setError(parsed.error.issues[0]?.message ?? "invalid");
      return;
    }
    setError(null);
    setAvailable("checking");
    const t = setTimeout(async () => {
      const api = new ApiClient(serverUrl);
      api.setToken(token);
      try {
        await api.getUserByHandle(value);
        setAvailable("no");
      } catch {
        setAvailable("yes");
      }
    }, 350);
    return () => clearTimeout(t);
  }, [value, serverUrl, token]);

  const submit = useCallback(async () => {
    setBusy(true);
    setError(null);
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    try {
      await api.setMyHandle(value);
      await refreshUser();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed");
    } finally {
      setBusy(false);
    }
  }, [serverUrl, token, value, refreshUser]);

  const canSubmit = !busy && available === "yes";

  return (
    <Modal
      open={true}
      onClose={() => { /* not dismissible */ }}
      dismissible={false}
      icon="@"
      title="Pick your handle"
      subtitle="How friends @mention you in chat. You can change it anytime from Settings › Account."
      width="min(92vw, 480px)"
      footer={
        <>
          <span style={{ fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
            Click the field to type your own.
          </span>
          <button
            className="rv-btn"
            data-variant="primary"
            data-disabled={!canSubmit || undefined}
            onClick={() => {
              if (canSubmit) void submit();
            }}
          >
            {busy ? "Saving…" : "Set handle"}
          </button>
        </>
      }
    >
      <div style={{ padding: "var(--s-5) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
        <div>
          <span className="rv-label" style={{ display: "block", marginBottom: "var(--s-2)" }}>
            Your handle
          </span>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              height: "2.5rem",
              padding: "0 var(--s-3)",
              border: "1.5px solid var(--text)",
              borderRadius: "var(--r-md)",
              background: "var(--bg-elev-2)",
              fontFamily: "var(--font-mono)",
              fontSize: "var(--t-base)",
              boxShadow: "0 0 0 3px color-mix(in srgb, var(--text) 6%, transparent)",
            }}
          >
            <span style={{ color: "var(--text-dim)", marginRight: 1 }}>@</span>
            <input
              autoFocus
              value={value}
              onChange={(e) => setValue(e.target.value)}
              disabled={busy}
              spellCheck={false}
              onKeyDown={(e) => {
                if (e.key === "Enter" && canSubmit) void submit();
              }}
              style={{
                flex: 1,
                minWidth: 0,
                border: 0,
                outline: "none",
                background: "transparent",
                font: "inherit",
                fontWeight: 500,
                color: "var(--text)",
              }}
            />
            <button
              type="button"
              className="rv-btn"
              onClick={() => setValue(whimsicalHandle())}
              disabled={busy}
              style={{ height: "1.75rem", padding: "0 var(--s-3)", fontSize: "var(--t-xs)", fontFamily: "var(--font-ui)" }}
            >
              🎲 Reroll
            </button>
          </div>
        </div>

        <div style={{ minHeight: "2.25rem" }}>
          {error && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-2)",
                fontSize: "var(--t-xs)",
                color: "var(--danger)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 14,
                  height: 14,
                  borderRadius: "50%",
                  background: "color-mix(in srgb, var(--danger) 10%, transparent)",
                  border: "1px solid color-mix(in srgb, var(--danger) 40%, transparent)",
                  display: "grid",
                  placeItems: "center",
                  fontSize: 9,
                  fontWeight: 700,
                  flexShrink: 0,
                }}
              >
                ✕
              </span>
              <span>{error}</span>
            </div>
          )}
          {!error && available === "no" && (
            <div style={{ fontSize: "var(--t-xs)", color: "var(--danger)" }}>
              @{value} is taken · try another
            </div>
          )}
          {!error && available === "checking" && (
            <div style={{ fontSize: "var(--t-xs)", color: "var(--text-faint)" }}>checking…</div>
          )}
          {!error && available === "yes" && (
            <div
              style={{
                display: "flex",
                alignItems: "center",
                gap: "var(--s-2)",
                padding: "var(--s-2) var(--s-3)",
                background: "color-mix(in srgb, var(--ok) 6%, transparent)",
                border: "1px solid color-mix(in srgb, var(--ok) 30%, transparent)",
                borderRadius: "var(--r-sm)",
                fontSize: "var(--t-xs)",
                color: "var(--text-mid)",
              }}
            >
              <span
                aria-hidden
                style={{
                  width: 7,
                  height: 7,
                  borderRadius: "50%",
                  background: "var(--ok)",
                  boxShadow: "0 0 5px color-mix(in srgb, var(--ok) 50%, transparent)",
                  flexShrink: 0,
                }}
              />
              <span>
                <span style={{ fontFamily: "var(--font-mono)", color: "var(--text)", fontWeight: 600 }}>
                  @{value}
                </span>{" "}
                is available
              </span>
            </div>
          )}
        </div>
      </div>
    </Modal>
  );
}
