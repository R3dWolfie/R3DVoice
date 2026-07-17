import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO, InviteDTO, RoomDTO, RoomMemberDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { Modal } from "./Modal.js";
import { Field } from "./Primitives.js";
import { Avatar } from "./Avatar.js";
import { CopyableInvite } from "./CopyableInvite.js";
import { InviteCreateModal } from "./InviteCreateModal.js";
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

  const api = useCallback(() => {
    const a = new ApiClient(serverUrl);
    a.setToken(token);
    return a;
  }, [serverUrl, token]);

  const isOwner = room.isOwner;

  const navItem = (key: Tab, label: string, danger?: boolean): ReactElement => (
    <button
      key={key}
      type="button"
      className="rv-menu-item"
      data-tone={danger ? "danger" : undefined}
      onClick={() => setTab(key)}
      style={{
        fontWeight: tab === key ? 600 : 500,
        background: tab === key ? "var(--bg-elev-3)" : undefined,
      }}
    >
      {label}
    </button>
  );

  return (
    <Modal
      open={true}
      onClose={onClose}
      title={room.name}
      subtitle={isOwner ? "Room settings · you own this room" : "Room settings"}
      width="min(94vw, 640px)"
    >
      <div style={{ display: "grid", gridTemplateColumns: "160px 1fr", minHeight: 340 }}>
        <nav
          style={{
            borderRight: "1px solid var(--border-soft)",
            padding: "var(--s-3) var(--s-2)",
            display: "flex",
            flexDirection: "column",
            gap: 2,
          }}
        >
          {navItem("overview", "Overview")}
          {navItem("members", "Members")}
          {isOwner && navItem("invites", "Invites")}
          {isOwner ? navItem("delete", "Delete room", true) : navItem("delete", "Leave room", true)}
        </nav>
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
            <MembersTab room={room} isOwner={isOwner} meId={meId ?? ""} api={api} onChanged={onChanged} onError={setError} />
          )}
          {tab === "invites" && isOwner && <InvitesTab room={room} api={api} onError={setError} />}
          {tab === "delete" && (
            <DangerTab room={room} isOwner={isOwner} api={api} onGone={onGone} onError={setError} />
          )}
        </div>
      </div>
    </Modal>
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
  const [saved, setSaved] = useState(false);

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
      setSaved(true);
      setTimeout(() => setSaved(false), 1500);
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
            {busy ? "Saving…" : saved ? "Saved ✓" : "Save changes"}
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
  onChanged,
  onError,
}: {
  room: RoomDTO;
  isOwner: boolean;
  meId: string;
  api: () => ApiClient;
  onChanged: () => void;
  onError: (e: string | null) => void;
}): ReactElement {
  const [members, setMembers] = useState<RoomMemberDTO[] | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

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

  const transfer = async (userId: string): Promise<void> => {
    setBusyId(userId);
    onError(null);
    try {
      await api().transferRoomOwnership(room.id, userId);
      onChanged();
      await refresh();
    } catch (e) {
      onError(e instanceof Error ? e.message : "failed to transfer");
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
                onClick={() => void transfer(m.userId)}
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
  const [invites, setInvites] = useState<InviteDTO[] | null>(null);
  const [createOpen, setCreateOpen] = useState(false);

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

  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-3)" }}>
      <div style={{ display: "flex", alignItems: "center" }}>
        <span className="rv-label" style={{ fontSize: "var(--t-2xs)", flex: 1 }}>
          Invite links for this room
        </span>
        <button
          className="rv-btn"
          data-variant="primary"
          style={{ height: "1.8rem", fontSize: "var(--t-xs)" }}
          onClick={() => setCreateOpen(true)}
        >
          <I.Plus size={12} /> Generate
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
          <div key={inv.id} style={{ display: "flex", alignItems: "center", gap: "var(--s-2)" }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <CopyableInvite code={inv.code} serverUrl={serverUrl} onClose={() => {}} />
              <div className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-faint)", marginTop: 2 }}>
                {inv.uses} use{inv.uses === 1 ? "" : "s"}
                {inv.maxUses !== null && ` / ${inv.maxUses}`}
                {inv.expiresAt && ` · expires ${new Date(inv.expiresAt).toLocaleDateString()}`}
              </div>
            </div>
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
    </div>
  );
}

function DangerTab({
  room,
  isOwner,
  api,
  onGone,
  onError,
}: {
  room: RoomDTO;
  isOwner: boolean;
  api: () => ApiClient;
  onGone: () => void;
  onError: (e: string | null) => void;
}): ReactElement {
  const [confirmText, setConfirmText] = useState("");
  const [busy, setBusy] = useState(false);
  const matches = confirmText === room.name;

  const act = async (): Promise<void> => {
    setBusy(true);
    onError(null);
    try {
      if (isOwner) await api().deleteRoom(room.id);
      else await api().leaveRoom(room.id);
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

  // 4.9d2: type-name confirm, Cancel-side-free — danger action gated on match.
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--s-4)", maxWidth: 380 }}>
      <div
        style={{
          padding: "var(--s-3) var(--s-4)",
          background: "color-mix(in srgb, var(--danger) 6%, transparent)",
          border: "1px solid color-mix(in srgb, var(--danger) 35%, transparent)",
          borderRadius: "var(--r-md)",
          fontSize: "var(--t-sm)",
          lineHeight: 1.5,
        }}
      >
        Deleting <b style={{ fontWeight: 600 }}>{room.name}</b> disconnects everyone in it,
        deletes its memberships, and kills every invite link. There is no undo.
      </div>
      <Field label={`Type the room name to confirm`} hint={room.name}>
        <input
          className="rv-input"
          value={confirmText}
          onChange={(e) => setConfirmText(e.target.value)}
          placeholder={room.name}
          spellCheck={false}
        />
      </Field>
      <div>
        <button
          className="rv-btn"
          data-variant="danger"
          data-disabled={!matches || busy || undefined}
          onClick={() => {
            if (matches && !busy) void act();
          }}
        >
          {busy ? "Deleting…" : "Delete room forever"}
        </button>
      </div>
    </div>
  );
}
