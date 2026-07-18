import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO, InviteDTO, RoomDTO, RoomMemberDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { pushToast } from "../lib/toast-store.js";
import { Modal } from "./Modal.js";
import { Field } from "./Primitives.js";
import { Avatar } from "./Avatar.js";
import { EditInviteModal } from "./EditInviteModal.js";
import { InviteCreateModal } from "./InviteCreateModal.js";
import { TransferOwnershipModal } from "./TransferOwnershipModal.js";
import { I } from "./Icons.js";

type Tab = "overview" | "members" | "invites" | "delete";

// Room settings per WireFrames 4.9 family: left-nav modal with Overview
// (4.9: name/description/privacy), Members (4.9b: kick + transfer),
// Invites (4.9c: room links + generate), Delete (4.9d/4.9d2: type-name
// confirm). Non-owners get a read-only overview plus Leave.
export function RoomSettingsModal({
  room,
  onClose,
  onChanged,
  onGone,
}: {
  room: RoomDTO;
  onClose: () => void;
  /** Room was renamed/toggled — caller refreshes its lists. */
  onChanged: () => void;
  /** Room was deleted or left — caller refreshes and drops references. */
  onGone: () => void;
}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const meId = useAuthStore((s) => s.user?.id);
  const [tab, setTab] = useState<Tab>("overview");
  const [error, setError] = useState<string | null>(null);
  // Nav-rail count badges (deck 4.9: "Members 12" / "Invites 3"). Re-fetched on
  // tab switches so kicks / new links keep the badges roughly in sync.
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [inviteCount, setInviteCount] = useState<number | null>(null);

  const api = useCallback(() => {
    const a = new ApiClient(serverUrl);
    a.setToken(token);
    return a;
  }, [serverUrl, token]);

  const isOwner = room.isOwner;

  useEffect(() => {
    let cancelled = false;
    void api()
      .listRoomMembers(room.id)
      .then((m) => {
        if (!cancelled) setMemberCount(m.length);
      })
      .catch(() => {});
    if (isOwner) {
      void api()
        .listMyInvites()
        .then((r) => {
          if (!cancelled)
            setInviteCount(
              r.invites.filter((i) => i.targetRoomId === room.id && i.revokedAt === null).length,
            );
        })
        .catch(() => {});
    }
    return () => {
      cancelled = true;
    };
  }, [api, room.id, isOwner, tab]);

  const navItem = (
    key: Tab,
    label: string,
    opts?: { danger?: boolean; count?: number | null },
  ): ReactElement => (
    <button
      key={key}
      type="button"
      className="rv-menu-item"
      data-tone={opts?.danger ? "danger" : undefined}
      onClick={() => setTab(key)}
      style={{
        fontWeight: tab === key ? 600 : 500,
        background: tab === key ? "var(--bg-elev-3)" : undefined,
      }}
    >
      {label}
      {opts?.count != null && (
        <span className="rv-mono" style={{ marginLeft: "auto", fontSize: "var(--t-2xs)", color: "var(--text-faint)" }}>
          {opts.count}
        </span>
      )}
    </button>
  );

  const paneTitle =
    tab === "overview"
      ? "Overview"
      : tab === "members"
        ? "Members"
        : tab === "invites"
          ? "Invites"
          : isOwner
            ? "Delete room"
            : "Leave room";

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={room.name}
      subtitle={isOwner ? "Room settings · you own this room" : "Room settings"}
      width="min(94vw, 640px)"
      hideHeader
    >
      <div style={{ display: "grid", gridTemplateColumns: "180px 1fr", height: "min(500px, 78vh)" }}>
        <nav
          style={{
            borderRight: "1px solid var(--border-soft)",
            padding: "var(--s-4) 0",
            display: "flex",
            flexDirection: "column",
            minHeight: 0,
          }}
        >
          <div className="rv-label" style={{ padding: "0 var(--s-4) var(--s-3)" }}>Room</div>
          <div
            className="rv-scroll"
            style={{ display: "flex", flexDirection: "column", gap: 2, padding: "0 var(--s-2)", overflowY: "auto", minHeight: 0 }}
          >
            {navItem("overview", "Overview")}
            {navItem("members", "Members", { count: memberCount })}
            {isOwner && navItem("invites", "Invites", { count: inviteCount })}
            {isOwner ? navItem("delete", "Delete room", { danger: true }) : navItem("delete", "Leave room", { danger: true })}
          </div>
          <RoomIdentityFoot room={room} isOwner={isOwner} />
        </nav>
        <div style={{ display: "grid", gridTemplateRows: "auto 1fr", minHeight: 0 }}>
          <PaneHead title={paneTitle} onClose={onClose} />
          <div className="rv-scroll" style={{ padding: "var(--s-5) var(--s-6)", overflowY: "auto", minHeight: 0 }}>
          {error && (
            <div className="rv-err-banner" role="alert" style={{ marginBottom: "var(--s-4)" }}>
              <span className="ic">!</span>
              <div>{error}</div>
            </div>
          )}
          {tab === "overview" && (
            <OverviewTab room={room} isOwner={isOwner} api={api} onChanged={onChanged} onError={setError} />
          )}
          {tab === "members" && (
            <MembersTab
              room={room}
              isOwner={isOwner}
              meId={meId ?? ""}
              api={api}
              onError={setError}
              onOwnershipTransferred={(left) => {
                if (left) {
                  onGone();
                } else {
                  onChanged();
                  onClose();
                }
              }}
            />
          )}
          {tab === "invites" && isOwner && <InvitesTab room={room} api={api} onError={setError} />}
          {tab === "delete" && (
            <DangerTab
              room={room}
              isOwner={isOwner}
              api={api}
              onGone={onGone}
              onError={setError}
              onCancel={() => setTab("overview")}
            />
          )}
          </div>
        </div>
      </div>
    </Modal>
  );
}

// Per-pane header (deck .pane-head): 18px pane title + close-✕, bordered below.
function PaneHead({ title, onClose }: { title: string; onClose: () => void }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: "var(--s-3)",
        padding: "var(--s-4) var(--s-6) var(--s-3)",
        borderBottom: "1px solid var(--border-soft)",
        flexShrink: 0,
      }}
    >
      <span style={{ fontSize: "var(--t-lg)", fontWeight: 600, letterSpacing: "-0.005em", color: "var(--text)" }}>
        {title}
      </span>
      <button className="rv-btn rv-btn-icon" data-variant="ghost" onClick={onClose} aria-label="Close">
        <I.X size={16} />
      </button>
    </div>
  );
}

// Nav-rail identity foot (deck .nav-foot) — room avatar + name + owner/member
// role, pinned to the bottom of the rail.
function RoomIdentityFoot({ room, isOwner }: { room: RoomDTO; isOwner: boolean }): ReactElement {
  return (
    <div
      style={{
        marginTop: "auto",
        display: "flex",
        alignItems: "center",
        gap: "var(--s-3)",
        padding: "var(--s-3) var(--s-4)",
        borderTop: "1px solid var(--border-soft)",
        minWidth: 0,
      }}
    >
      <Avatar src={null} fallbackInitials={room.name} fallbackColorSeed={room.id} size={32} shape="rounded" />
      <div style={{ display: "flex", flexDirection: "column", minWidth: 0 }}>
        <span
          style={{
            fontSize: "var(--t-sm)",
            fontWeight: 600,
            color: "var(--text)",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {room.name}
        </span>
        <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>
          {isOwner ? "Owner" : "Member"}
        </span>
      </div>
    </div>
  );
}

function OverviewTab({
  room,
  isOwner,
  api,
  onChanged,
  onError,
}: {
  room: RoomDTO;
  isOwner: boolean;
  api: () => ApiClient;
  onChanged: () => void;
  onError: (e: string | null) => void;
}): ReactElement {
  const [name, setName] = useState(room.name);
  const [description, setDescription] = useState(room.description ?? "");
  const [isPublic, setIsPublic] = useState(room.isPublic);
  const [busy, setBusy] = useState(false);

  const dirty =
    name.trim() !== room.name ||
    (description.trim() || null) !== (room.description ?? null) ||
    isPublic !== room.isPublic;

  const save = async (): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      await api().updateRoom(room.id, {
        name: name.trim(),
        isPublic,
        description: description.trim() === "" ? null : description.trim(),
      });
      onChanged();
      pushToast({ kind: "success", text: "Room settings saved", sub: name.trim() });
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed to save");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-5)" }}>
      <Field label="Name">
        <input
          className="rv-input"
          value={name}
          maxLength={80}
          disabled={!isOwner || busy}
          onChange={(e) => setName(e.target.value)}
        />
      </Field>
      <Field label="Description" hint="Shown in Browse public rooms when this room is Public.">
        <textarea
          className="rv-input"
          value={description}
          maxLength={500}
          disabled={!isOwner || busy}
          onChange={(e) => setDescription(e.target.value)}
          placeholder="What's this room for?"
          style={{ height: "4.5rem", padding: "var(--s-2) var(--s-3)", resize: "vertical", fontFamily: "inherit" }}
        />
      </Field>
      <Field
        label="Privacy"
        hint={
          isPublic
            ? "Anyone can join; listed in the public directory."
            : "Anyone with the link can join; hidden from browse."
        }
      >
        <div className="rv-seg" style={{ alignSelf: "flex-start" }}>
          <button
            type="button"
            className="rv-seg-btn"
            data-active={isPublic}
            disabled={!isOwner}
            onClick={() => setIsPublic(true)}
          >
            Public
          </button>
          <button
            type="button"
            className="rv-seg-btn"
            data-active={!isPublic}
            disabled={!isOwner}
            onClick={() => setIsPublic(false)}
          >
            Unlisted
          </button>
          <button
            type="button"
            className="rv-seg-btn"
            disabled
            title="Invite-only rooms are coming with the private visibility tier."
            style={{ opacity: 0.45 }}
          >
            Private
          </button>
        </div>
      </Field>
      {isOwner && (
        <div>
          <button
            type="button"
            className="rv-btn"
            data-variant="primary"
            data-disabled={!dirty || busy || !name.trim() || undefined}
            onClick={() => {
              if (dirty && !busy && name.trim()) void save();
            }}
          >
            {busy ? "Saving…" : "Save changes"}
          </button>
        </div>
      )}
    </div>
  );
}

function MembersTab({
  room,
  isOwner,
  meId,
  api,
  onError,
  onOwnershipTransferred,
}: {
  room: RoomDTO;
  isOwner: boolean;
  meId: string;
  api: () => ApiClient;
  onError: (e: string | null) => void;
  onOwnershipTransferred: (left: boolean) => void;
}): ReactElement {
  const [members, setMembers] = useState<RoomMemberDTO[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [transferFor, setTransferFor] = useState<RoomMemberDTO | null>(null);

  const refresh = useCallback(async () => {
    try {
      setMembers(await api().listRoomMembers(room.id));
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed to load members");
    }
  }, [api, room.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const kick = async (userId: string): Promise<void> => {
    setBusyId(userId);
    onError(null);
    try {
      await api().removeRoomMember(room.id, userId);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed to remove");
    } finally {
      setBusyId(null);
    }
  };

  if (members === null) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-2)" }}>
        <div className="rv-skeleton" style={{ height: "2.5rem" }} />
        <div className="rv-skeleton" style={{ height: "2.5rem" }} />
      </div>
    );
  }

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 2 }}>
      <div className="rv-label" style={{ marginBottom: "var(--s-2)", fontSize: "var(--t-2xs)" }}>
        Members · {members.length}
      </div>
      {members.map((m) => (
        <div
          key={m.userId}
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--s-3)",
            padding: "var(--s-2) var(--s-2)",
            borderRadius: "var(--r-sm)",
          }}
        >
          <Avatar src={null} fallbackInitials={m.displayName} fallbackColorSeed={m.userId} size={30} />
          <div style={{ flex: 1, minWidth: 0, fontSize: "var(--t-sm)" }}>
            {m.displayName}
            {m.userId === meId && <span style={{ color: "var(--text-dim)" }}> (you)</span>}
            {m.isOwner && (
              <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--rv-amber)", marginLeft: 6 }}>
                owner
              </span>
            )}
          </div>
          {isOwner && !m.isOwner && (
            <>
              <button
                className="rv-btn"
                style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
                disabled={busyId !== null}
                title="Make this member the owner"
                onClick={() => setTransferFor(m)}
              >
                Make owner
              </button>
              <button
                className="rv-btn"
                data-variant="danger"
                style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
                disabled={busyId !== null}
                onClick={() => void kick(m.userId)}
              >
                {busyId === m.userId ? "…" : "Remove"}
              </button>
            </>
          )}
        </div>
      ))}
      {members.length === 0 && (
        <div className="rv-empty" style={{ padding: "var(--s-6) 0" }}>
          <span className="rv-empty-title">No members yet</span>
          <span className="rv-empty-hint">Share an invite link to get people in.</span>
        </div>
      )}

      {isOwner && (
        <InviteFriendsSection roomId={room.id} memberIds={members.map((m) => m.userId)} api={api} onInvited={refresh} />
      )}

      {transferFor && (
        <TransferOwnershipModal
          room={room}
          members={members}
          preselectedUserId={transferFor.userId}
          api={api}
          onClose={() => setTransferFor(null)}
          onDone={(left) => {
            setTransferFor(null);
            onOwnershipTransferred(left);
          }}
        />
      )}
    </div>
  );
}

// 4.16 — invite friends straight into the room (no link needed).
function InviteFriendsSection({
  roomId,
  memberIds,
  api,
  onInvited,
}: {
  roomId: string;
  memberIds: string[];
  api: () => ApiClient;
  onInvited: () => Promise<void>;
}): ReactElement | null {
  const [friends, setFriends] = useState<FriendDTO[]>([]);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    api()
      .friends()
      .then((r) => {
        if (!cancelled) setFriends(r.friends.filter((f) => f.status === "accepted"));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api]);

  const candidates = friends.filter((f) => !memberIds.includes(f.user.id));
  if (candidates.length === 0) return null;

  return (
    <div style={{ marginTop: "var(--s-5)" }}>
      <div className="rv-label" style={{ marginBottom: "var(--s-2)", fontSize: "var(--t-2xs)" }}>
        Invite friends
      </div>
      {candidates.map((f) => (
        <div
          key={f.user.id}
          style={{ display: "flex", alignItems: "center", gap: "var(--s-3)", padding: "var(--s-2) var(--s-2)" }}
        >
          <Avatar src={f.user.avatarUrl ?? null} fallbackInitials={f.user.displayName} fallbackColorSeed={f.user.id} size={26} />
          <span style={{ flex: 1, minWidth: 0, fontSize: "var(--t-sm)" }}>
            {f.user.displayName}
            {f.user.handle && (
              <span className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}> @{f.user.handle}</span>
            )}
          </span>
          <button
            className="rv-btn"
            data-variant="primary"
            style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
            disabled={busyId !== null}
            onClick={() => {
              setBusyId(f.user.id);
              void api()
                .inviteRoomMember(roomId, f.user.id)
                .then(() => onInvited())
                .finally(() => setBusyId(null));
            }}
          >
            {busyId === f.user.id ? "…" : "Add"}
          </button>
        </div>
      ))}
    </div>
  );
}

/** 4.9c meta line: "Expires in 5 days · 12 uses" / "Single-use · unused" / "Never expires · 47 uses". */
function inviteMetaLine(inv: InviteDTO): string {
  if (inv.maxUses === 1) return `Single-use · ${inv.uses === 0 ? "unused" : "used"}`;
  const uses = inv.maxUses !== null ? `${inv.uses}/${inv.maxUses} uses` : `${inv.uses} use${inv.uses === 1 ? "" : "s"}`;
  if (inv.expiresAt === null) return `Never expires · ${uses}`;
  const ms = Date.parse(inv.expiresAt) - Date.now();
  if (ms <= 0) return `Expired · ${uses}`;
  const days = Math.round(ms / 86_400_000);
  if (days >= 2) return `Expires in ${days} days · ${uses}`;
  const hours = Math.max(1, Math.round(ms / 3_600_000));
  return `Expires in ${hours}h · ${uses}`;
}

function InvitesTab({
  room,
  api,
  onError,
}: {
  room: RoomDTO;
  api: () => ApiClient;
  onError: (e: string | null) => void;
}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const myHandle = useAuthStore((s) => s.user?.handle ?? null);
  const [invites, setInvites] = useState<InviteDTO[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [editing, setEditing] = useState<InviteDTO | null>(null);

  const refresh = useCallback(async () => {
    try {
      const r = await api().listMyInvites();
      setInvites(r.invites.filter((i) => i.targetRoomId === room.id && i.revokedAt === null));
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed to load invites");
    }
  }, [api, room.id, onError]);

  useEffect(() => {
    void refresh();
  }, [refresh, createOpen]);

  const revoke = async (id: string): Promise<void> => {
    onError(null);
    try {
      await api().revokeInvite(id);
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed to revoke");
    }
  };

  const copy = async (inv: InviteDTO): Promise<void> => {
    const url = `${serverUrl.replace(/\/$/, "")}/invite/${inv.code}`;
    try {
      await navigator.clipboard.writeText(url);
      pushToast({ kind: "success", text: "Invite link copied", sub: url });
    } catch {
      pushToast({ kind: "error", text: "Couldn't access the clipboard" });
    }
  };

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      {/* 4.9c header: "N active links to {room}. Anyone with a link can join." */}
      <div style={{ display: "flex", alignItems: "center", gap: "var(--s-3)" }}>
        <span style={{ fontSize: "var(--t-sm)", color: "var(--text-mid)", flex: 1 }}>
          {invites === null
            ? "Loading links…"
            : `${invites.length} active link${invites.length === 1 ? "" : "s"} to `}
          {invites !== null && <b style={{ fontWeight: 600, color: "var(--text)" }}>{room.name}</b>}
          {invites !== null && ". Anyone with a link can join."}
        </span>
        <button
          className="rv-btn"
          data-variant="primary"
          style={{ height: "1.8rem", fontSize: "var(--t-xs)", flexShrink: 0 }}
          onClick={() => setCreateOpen(true)}
        >
          <I.Plus size={12} /> Generate invite link
        </button>
      </div>
      {invites === null ? (
        <div className="rv-skeleton" style={{ height: "2.5rem" }} />
      ) : invites.length === 0 ? (
        <div className="rv-empty" style={{ padding: "var(--s-5) 0" }}>
          <span className="rv-empty-title">No active links</span>
          <span className="rv-empty-hint">Generate one — links can expire or be single-use.</span>
        </div>
      ) : (
        invites.map((inv) => (
          <div
            key={inv.id}
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--s-2)",
              padding: "var(--s-2) var(--s-3)",
              border: "1px solid var(--border-soft)",
              borderRadius: "var(--r-md)",
              background: "var(--bg-elev)",
            }}
          >
            <button
              type="button"
              onClick={() => setEditing(inv)}
              title="Invite link settings"
              style={{
                flex: 1,
                minWidth: 0,
                appearance: "none",
                border: 0,
                background: "transparent",
                textAlign: "left",
                cursor: "pointer",
                padding: 0,
              }}
            >
              <div
                className="rv-mono"
                style={{
                  fontSize: "var(--t-sm)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {serverUrl.replace(/^https?:\/\//, "").replace(/\/$/, "")}/invite/{inv.code}
              </div>
              <div style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)", marginTop: 2 }}>
                {myHandle ? `by @${myHandle}` : "by you"} · {inviteMetaLine(inv)}
              </div>
            </button>
            <button
              className="rv-btn rv-btn-icon"
              data-variant="ghost"
              title="Copy link"
              aria-label="Copy link"
              style={{ height: "1.7rem", width: "1.7rem" }}
              onClick={() => void copy(inv)}
            >
              <I.Copy size={13} />
            </button>
            <button
              className="rv-btn"
              data-variant="danger"
              style={{ height: "1.7rem", fontSize: "var(--t-2xs)" }}
              onClick={() => void revoke(inv.id)}
            >
              Revoke
            </button>
          </div>
        ))
      )}
      {createOpen && <InviteCreateModal open={true} roomId={room.id} onClose={() => setCreateOpen(false)} />}
      {editing && (
        <EditInviteModal
          invite={editing}
          roomName={room.name}
          serverUrl={serverUrl}
          myHandle={myHandle}
          api={api}
          onClose={() => setEditing(null)}
          onChanged={() => void refresh()}
        />
      )}
    </div>
  );
}

/** Red callout used by both delete steps (4.9d / 4.9d2). */
function DangerCallout({ head, sub }: { head: string; sub: string }): ReactElement {
  return (
    <div
      style={{
        display: "flex",
        gap: "var(--s-3)",
        alignItems: "flex-start",
        padding: "var(--s-3) var(--s-4)",
        background: "color-mix(in srgb, var(--danger) 6%, transparent)",
        border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
        borderRadius: "var(--r-md)",
      }}
    >
      <span
        aria-hidden
        style={{
          width: "1.5rem",
          height: "1.5rem",
          borderRadius: "50%",
          border: "1.5px solid var(--danger)",
          color: "var(--danger)",
          display: "grid",
          placeItems: "center",
          fontWeight: 700,
          fontSize: "var(--t-sm)",
          flexShrink: 0,
        }}
      >
        !
      </span>
      <div style={{ fontSize: "var(--t-sm)", lineHeight: 1.45 }}>
        <div style={{ fontWeight: 600 }}>{head}</div>
        <div style={{ color: "var(--text-mid)" }}>{sub}</div>
      </div>
    </div>
  );
}

function DangerTab({
  room,
  isOwner,
  api,
  onGone,
  onError,
  onCancel,
}: {
  room: RoomDTO;
  isOwner: boolean;
  api: () => ApiClient;
  onGone: () => void;
  onError: (e: string | null) => void;
  onCancel: () => void;
}): ReactElement {
  // 4.9d two-step flow: step 1 = impact summary, step 2 = type-name confirm.
  const [step, setStep] = useState<1 | 2>(1);
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const [memberCount, setMemberCount] = useState<number | null>(null);
  const [inviteCount, setInviteCount] = useState<number | null>(null);
  const matches = confirmText === room.name;

  useEffect(() => {
    if (!isOwner) return;
    let cancelled = false;
    void api()
      .listRoomMembers(room.id)
      .then((m) => {
        if (!cancelled) setMemberCount(m.length);
      })
      .catch(() => {});
    void api()
      .listMyInvites()
      .then((r) => {
        if (!cancelled)
          setInviteCount(
            r.invites.filter((i) => i.targetRoomId === room.id && i.revokedAt === null).length,
          );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, room.id, isOwner]);

  const act = async (): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      if (isOwner) await api().deleteRoom(room.id);
      else await api().leaveRoom(room.id);
      pushToast({
        kind: isOwner ? "info" : "undo",
        text: isOwner ? `Deleted ${room.name}` : `Left ${room.name}`,
      });
      onGone();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed");
      setBusy(false);
    }
  };

  if (!isOwner) {
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", maxWidth: 380 }}>
        <p style={{ margin: 0, fontSize: "var(--t-sm)", color: "var(--text-mid)", lineHeight: 1.5 }}>
          Leaving removes this room from your list. You can rejoin any time with the link
          {room.isPublic ? " or from the public directory" : ""}.
        </p>
        <div>
          <button className="rv-btn" data-variant="danger" disabled={busy} onClick={() => void act()}>
            {busy ? "Leaving…" : "Leave room"}
          </button>
        </div>
      </div>
    );
  }

  const members = memberCount ?? 0;
  const links = inviteCount ?? 0;

  if (step === 1) {
    // 4.9d step 1 — impact summary. Nothing destructive happens here.
    return (
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", maxWidth: 420 }}>
        <DangerCallout head="This is irreversible." sub="Read everything below before continuing." />
        <div style={{ fontSize: "var(--t-sm)", lineHeight: 1.55 }}>
          Are you sure you want to delete <b style={{ fontWeight: 600 }}>{room.name}</b>?
          <ul style={{ margin: "var(--s-2) 0 0", paddingLeft: "1.1rem", color: "var(--text-mid)" }}>
            <li>
              All {memberCount ?? "…"} member{members === 1 ? "" : "s"} will be ejected from the
              room.
            </li>
            <li>
              All {inviteCount ?? "…"} active invite link{links === 1 ? "" : "s"} will be revoked
              permanently.
            </li>
            <li>The full room chat history will be deleted.</li>
            <li>Anyone currently in voice will be disconnected mid-call.</li>
            <li>Members will not be notified ahead of time.</li>
          </ul>
        </div>
        <div
          style={{
            display: "flex",
            gap: "var(--s-3)",
            alignItems: "flex-start",
            padding: "var(--s-3) var(--s-4)",
            background: "var(--bg-elev-2)",
            border: "1px solid var(--border-soft)",
            borderRadius: "var(--r-md)",
            fontSize: "var(--t-xs)",
            lineHeight: 1.5,
            color: "var(--text-mid)",
          }}
        >
          <span aria-hidden style={{ color: "var(--rv-amber)", fontWeight: 700 }}>
            ⚠
          </span>
          <span>
            Please be careful. Once a room is deleted, R3DVoice cannot recover it — not even by
            support, not even with the room ID. If this room has any value to anyone else, consider
            transferring ownership instead from the Members tab.
          </span>
        </div>
        <div style={{ display: "flex", gap: "var(--s-2)", justifyContent: "flex-end" }}>
          <button className="rv-btn" data-variant="ghost" onClick={onCancel}>
            Cancel
          </button>
          <button className="rv-btn" data-variant="danger" onClick={() => setStep(2)}>
            I understand, continue
          </button>
        </div>
      </div>
    );
  }

  // 4.9d2 step 2 — type-name confirm; the delete button gates on an exact match.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", maxWidth: 420 }}>
      <DangerCallout head="Last chance." sub="Type the room name to confirm deletion." />
      <p style={{ margin: 0, fontSize: "var(--t-sm)", color: "var(--text-mid)", lineHeight: 1.55 }}>
        You&apos;re about to permanently delete{" "}
        <b style={{ fontWeight: 600, color: "var(--text)" }}>{room.name}</b> and disconnect{" "}
        {memberCount ?? "…"} member{members === 1 ? "" : "s"}. This cannot be undone — please be
        careful.
      </p>
      <Field label="Confirm room name" hint={`Type ${room.name} exactly to enable the delete button.`}>
        <input
          className="rv-input"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={room.name}
          spellCheck={false}
          autoFocus
        />
      </Field>
      <div style={{ display: "flex", gap: "var(--s-2)", justifyContent: "flex-end" }}>
        <button
          className="rv-btn"
          data-variant="ghost"
          onClick={() => {
            setConfirmText("");
            setStep(1);
          }}
        >
          Cancel
        </button>
        <button
          className="rv-btn"
          data-variant="danger"
          data-disabled={!matches || busy || undefined}
          onClick={() => {
            if (matches && !busy) void act();
          }}
        >
          {busy ? "Deleting…" : "Delete room"}
        </button>
      </div>
    </div>
  );
}
