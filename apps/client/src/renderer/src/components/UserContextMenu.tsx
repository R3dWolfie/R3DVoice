import { useCallback, useEffect, useState, type ReactElement } from "react";
import type { FriendDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { dmThreadId } from "../lib/dm-thread-id.js";
import { Avatar } from "./Avatar.js";
import { ContextMenu, MenuItem, MenuDivider, MenuSection } from "./ContextMenu.js";
import { MutePopover } from "./MutePopover.js";
import { pushToast } from "../lib/toast-store.js";

// Full user menu per WireFrames 2.4d - right-click / ⋮ on a person:
// View profile · Send DM · [Notifications] Mute (2.4b popover) ·
// Copy handle · Block · Remove friend. Friendship state (for presence +
// Remove friend) is resolved from the caller's friends list on open.
// "Invite to room…" from the deck is intentionally absent here: these
// surfaces (Friends page, DM headers) never coexist with an active call,
// so there is no current room to offer.
export function UserContextMenu({
  x,
  y,
  user,
  meId,
  onClose,
  onViewProfile,
  onSendDm,
  onChanged,
}: {
  x: number;
  y: number;
  user: { id: string; handle: string | null; displayName: string };
  meId: string;
  onClose: () => void;
  onViewProfile?: (() => void) | undefined;
  onSendDm?: (() => void) | undefined;
  /** Fires after block / remove-friend so callers can refresh lists. */
  onChanged?: (() => void) | undefined;
}): ReactElement {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const [friend, setFriend] = useState<FriendDTO | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [muteOpen, setMuteOpen] = useState(false);
  const [blockArmed, setBlockArmed] = useState(false);
  const [removeArmed, setRemoveArmed] = useState(false);

  const apiFor = useCallback(() => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  }, [serverUrl, token]);

  useEffect(() => {
    let cancelled = false;
    apiFor()
      .friends()
      .then((r) => {
        if (cancelled) return;
        setFriend(r.friends.find((f) => f.user.id === user.id) ?? null);
        setLoaded(true);
      })
      .catch(() => setLoaded(true));
    return () => {
      cancelled = true;
    };
  }, [apiFor, user.id]);

  const handleText = user.handle ? `@${user.handle}` : user.displayName;
  const accepted = friend?.status === "accepted";
  const presence = !loaded ? "…" : accepted ? (friend?.isOnline ? "online" : "offline") : "not a friend yet";

  // 2.4b timed-mute popover replaces the menu once "Mute" is picked.
  if (muteOpen) {
    const clampedX = Math.min(x, window.innerWidth - 288);
    const clampedY = Math.min(y, window.innerHeight - 420);
    return (
      <div style={{ position: "fixed", left: clampedX, top: clampedY, zIndex: 60 }}>
        <MutePopover
          threadType="dm"
          threadId={dmThreadId(meId, user.id)}
          targetLabel={handleText}
          onClose={onClose}
          style={{ position: "static" }}
        />
      </div>
    );
  }

  return (
    <ContextMenu
      x={x}
      y={y}
      onClose={onClose}
      header={
        <>
          <Avatar src={null} fallbackInitials={user.displayName} fallbackColorSeed={user.id} size={30} />
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 600, fontSize: "var(--t-sm)", whiteSpace: "nowrap", overflow: "hidden", textOverflow: "ellipsis" }}>
              {user.displayName}
            </div>
            <div className="rv-mono" style={{ fontSize: "var(--t-2xs)", color: "var(--text-dim)" }}>
              {user.handle ? `@${user.handle} · ` : ""}
              {presence}
            </div>
          </div>
        </>
      }
    >
      <MenuItem
        icon="👤"
        label="View profile"
        onClick={() => {
          onClose();
          onViewProfile?.();
        }}
      />
      <MenuItem
        icon="✉"
        label="Send DM"
        onClick={() => {
          onClose();
          onSendDm?.();
        }}
      />
      <MenuSection label="Notifications" />
      <MenuItem icon="🔕" label="Mute" onClick={() => setMuteOpen(true)} />
      <MenuDivider />
      <MenuItem
        icon="⧉"
        label="Copy handle"
        onClick={() => {
          // Toast only after the write resolves - a denied/unfocused clipboard
          // must not flash a false "copied".
          void navigator.clipboard
            .writeText(handleText)
            .then(() => pushToast({ kind: "success", text: "Handle copied" }))
            .catch(() => pushToast({ kind: "error", text: "Couldn't copy handle" }));
          onClose();
        }}
      />
      <MenuDivider />
      <MenuItem
        icon="⊘"
        label={blockArmed ? "Really block? Click again" : `Block ${handleText}`}
        tone="danger"
        onClick={() => {
          if (!blockArmed) {
            setBlockArmed(true);
            return;
          }
          // Only dismiss on success - a swallowed failure would falsely imply
          // the user was blocked and leave the list unrefreshed.
          void apiFor()
            .blockUser(user.id)
            .then(() => {
              onChanged?.();
              onClose();
            })
            .catch(() => pushToast({ kind: "error", text: `Couldn't block ${handleText}` }));
        }}
      />
      {accepted && friend && (
        <MenuItem
          icon="✕"
          label={removeArmed ? "Really remove? Click again" : "Remove friend"}
          tone="danger"
          onClick={() => {
            if (!removeArmed) {
              setRemoveArmed(true);
              return;
            }
            // Close only once the removal lands; otherwise surface the error so
            // the friend isn't silently left in the list.
            void apiFor()
              .friendReject(friend.friendshipId)
              .then(() => {
                onChanged?.();
                onClose();
              })
              .catch(() => pushToast({ kind: "error", text: `Couldn't remove ${handleText}` }));
          }}
        />
      )}
    </ContextMenu>
  );
}
