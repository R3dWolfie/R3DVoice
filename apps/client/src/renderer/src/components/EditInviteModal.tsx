import { useState, type ReactElement } from "react";
import type { InviteDTO } from "@r3dvoice/shared";
import type { ApiClient } from "../lib/api.js";
import { pushToast } from "../lib/toast-store.js";
import { Modal } from "./Modal.js";
import { I } from "./Icons.js";

// 4.9c1 — invite link settings: link + copy, created/by/uses stats, expiry
// select, single-use toggle, max-uses tiers (2.3b: 1 / 5 / 25 / 100 /
// Unlimited), revoke, and ↻ regenerate (4.9c2). The server has no invite
// PATCH — "Save changes" and "Regenerate" are revoke + create under the hood,
// which always mints a fresh code.

const EXPIRY_CHOICES = [
  { key: "1h", label: "1 hour", ms: 3_600_000 },
  { key: "1d", label: "1 day", ms: 86_400_000 },
  { key: "7d", label: "7 days", ms: 7 * 86_400_000 },
  { key: "never", label: "Never", ms: null },
] as const;

const MAX_USES_TIERS: { label: string; value: number | null }[] = [
  { label: "1", value: 1 },
  { label: "5", value: 5 },
  { label: "25", value: 25 },
  { label: "100", value: 100 },
  { label: "∞", value: null },
];

function expiryLabel(expiresAt: string | null): string {
  if (expiresAt === null) return "Never";
  const ms = Date.parse(expiresAt) - Date.now();
  if (ms <= 0) return "Expired";
  const days = Math.round(ms / 86_400_000);
  if (days >= 2) return `In ${days} days`;
  const hours = Math.round(ms / 3_600_000);
  if (hours >= 2) return `In ${hours} hours`;
  return `In ${Math.max(1, Math.round(ms / 60_000))} min`;
}

function createdAgo(iso: string): string {
  const ms = Date.now() - Date.parse(iso);
  const days = Math.floor(ms / 86_400_000);
  if (days >= 2) return `${days} days ago`;
  if (days === 1) return "yesterday";
  const hours = Math.floor(ms / 3_600_000);
  if (hours >= 1) return `${hours}h ago`;
  return "just now";
}

function inviteUrl(serverUrl: string, code: string): string {
  return `${serverUrl.replace(/\/$/, "")}/invite/${code}`;
}

export function EditInviteModal({
  invite,
  roomName,
  serverUrl,
  myHandle,
  api,
  onClose,
  onChanged,
}: {
  invite: InviteDTO;
  roomName: string;
  serverUrl: string;
  myHandle: string | null;
  api: () => ApiClient;
  onClose: () => void;
  /** A revoke/regenerate happened — parent refreshes its list. */
  onChanged: () => void;
}): ReactElement {
  const [current, setCurrent] = useState<InviteDTO>(invite);
  const [expiryChoice, setExpiryChoice] = useState<"current" | (typeof EXPIRY_CHOICES)[number]["key"]>("current");
  const [maxUses, setMaxUses] = useState<number | null>(invite.maxUses);
  const [busy, setBusy] = useState<"save" | "regen" | "revoke" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const url = inviteUrl(serverUrl, current.code);
  const dirty = expiryChoice !== "current" || maxUses !== current.maxUses;

  const targetExpiresAt = (): string | null => {
    if (expiryChoice === "current") return current.expiresAt;
    const choice = EXPIRY_CHOICES.find((c) => c.key === expiryChoice)!;
    return choice.ms === null ? null : new Date(Date.now() + choice.ms).toISOString();
  };

  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ kind: "success", text: "Invite link copied", sub: url });
    } catch {
      pushToast({ kind: "error", text: "Couldn't access the clipboard" });
    }
  };

  /** Revoke + create — the only way to change settings or mint a new code. */
  const reissue = async (kind: "save" | "regen"): Promise<void> => {
    setBusy(kind);
    setError(null);
    try {
      const expiresAt = kind === "save" ? targetExpiresAt() : current.expiresAt;
      const nextMaxUses = kind === "save" ? maxUses : current.maxUses;
      const created = (await api().createInvite({
        kind: current.kind,
        ...(current.targetRoomId !== null && { targetRoomId: current.targetRoomId }),
        expiresAt,
        maxUses: nextMaxUses,
      })) as InviteDTO;
      await api().revokeInvite(current.id);
      setCurrent(created);
      setExpiryChoice("current");
      setMaxUses(created.maxUses);
      onChanged();
      pushToast({
        kind: "success",
        text: kind === "save" ? "Invite link updated" : "New link generated",
        sub: inviteUrl(serverUrl, created.code),
      });
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to update the link");
    } finally {
      setBusy(null);
    }
  };

  const revoke = async (): Promise<void> => {
    setBusy("revoke");
    setError(null);
    try {
      await api().revokeInvite(current.id);
      pushToast({ kind: "info", text: "Invite link revoked", sub: url });
      onChanged();
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : "failed to revoke");
      setBusy(null);
    }
  };

  const stat = (label: string, value: string): ReactElement => (
    <div style={{ display: "flex", flexDirection: "column", gap: 2, minWidth: 0 }}>
      <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>
        {label}
      </span>
      <span className="rv-mono" style={{ fontSize: "var(--t-sm)" }}>
        {value}
      </span>
    </div>
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title="Invite link settings"
      subtitle={roomName}
      width="min(94vw, 460px)"
      footer={
        <>
          <button
            type="button"
            className="rv-btn"
            data-variant="danger"
            data-disabled={busy !== null || undefined}
            onClick={() => {
              if (busy === null) void revoke();
            }}
          >
            {busy === "revoke" ? "Revoking…" : "Revoke link"}
          </button>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <button type="button" className="rv-btn" data-variant="ghost" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="rv-btn"
              data-variant="primary"
              data-disabled={!dirty || busy !== null || undefined}
              title="Settings changes mint a fresh code (the old link stops working)"
              onClick={() => {
                if (dirty && busy === null) void reissue("save");
              }}
            >
              {busy === "save" ? "Saving…" : "Save changes"}
            </button>
          </div>
        </>
      }
    >
      <div style={{ padding: "var(--s-5) var(--s-6)", display: "flex", flexDirection: "column", gap: "var(--s-4)" }}>
        {error && (
          <div className="rv-err-banner" role="alert">
            <span className="ic">!</span>
            <div>{error}</div>
          </div>
        )}

        <div className="rv-field">
          <span className="rv-label">Link</span>
          <div style={{ display: "flex", gap: "var(--s-2)" }}>
            <input
              className="rv-input"
              readOnly
              value={url}
              style={{ flex: 1, fontFamily: "var(--font-mono)", fontSize: "var(--t-sm)" }}
            />
            <button type="button" className="rv-btn" onClick={() => void copy()}>
              <I.Copy size={13} /> Copy
            </button>
          </div>
        </div>

        <div
          style={{
            display: "grid",
            gridTemplateColumns: "1fr 1fr 1fr",
            gap: "var(--s-3)",
            padding: "var(--s-3) var(--s-4)",
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-md)",
          }}
        >
          {stat("Created", createdAgo(current.createdAt))}
          {stat("By", myHandle ? `@${myHandle}` : "you")}
          {stat("Uses", String(current.uses))}
        </div>

        <div className="rv-field">
          <span className="rv-label">Expires</span>
          <select
            className="rv-select"
            value={expiryChoice}
            onChange={(e) => setExpiryChoice(e.target.value as typeof expiryChoice)}
          >
            <option value="current">{expiryLabel(current.expiresAt)} (current)</option>
            {EXPIRY_CHOICES.map((c) => (
              <option key={c.key} value={c.key}>
                {c.label}
              </option>
            ))}
          </select>
        </div>

        <label className="rv-check">
          <input
            type="checkbox"
            checked={maxUses === 1}
            onChange={(e) => setMaxUses(e.target.checked ? 1 : null)}
          />
          <span className="rv-check-box" />
          <span style={{ fontSize: "var(--t-sm)" }}>
            Single-use
            <span style={{ display: "block", fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
              Link revokes itself the first time someone joins.
            </span>
          </span>
        </label>

        <div className="rv-field">
          <span className="rv-label">Max uses</span>
          <div className="rv-seg" style={{ alignSelf: "flex-start" }}>
            {MAX_USES_TIERS.map((t) => (
              <button
                key={t.label}
                type="button"
                className="rv-seg-btn"
                data-active={maxUses === t.value}
                onClick={() => setMaxUses(t.value)}
              >
                {t.label === "∞" ? "Unlimited" : t.label}
              </button>
            ))}
          </div>
          <span className="rv-field-help">Leave at Unlimited for no limit, or pick a cap.</span>
        </div>

        <div>
          <button
            type="button"
            className="rv-btn"
            data-disabled={busy !== null || undefined}
            onClick={() => {
              if (busy === null) void reissue("regen");
            }}
          >
            {busy === "regen" ? "Regenerating…" : "↻ Regenerate link"}
          </button>
          <span style={{ display: "block", marginTop: "var(--s-1)", fontSize: "var(--t-xs)", color: "var(--text-dim)" }}>
            Mints a fresh code with the same settings. The old link stops working.
          </span>
        </div>
      </div>
    </Modal>
  );
}
