import { useEffect, useState, type ReactElement } from "react";
import { create } from "zustand";
import type { DirectInviteDTO } from "@r3dvoice/shared";
import { useAuthStore } from "../lib/auth-context.js";
import { ApiClient } from "../lib/api.js";
import { getTransport } from "../lib/chat-transport.js";
import { useNotificationsStore } from "../lib/notifications-store.js";
import { pushToast } from "../lib/toast-store.js";
import { Avatar } from "./Avatar.js";

// 4.3 - in-app corner invite queue. Directed room invites that arrive live
// over the WS stack as cards: who + room + Join room / Dismiss, with a
// "Dismiss all" row when more than one is queued. State is transient - the
// bell (4.15) remains the durable list; × just clears the popup.

interface InviteQueueState {
  queue: DirectInviteDTO[];
  add(invite: DirectInviteDTO): void;
  remove(id: string): void;
  clear(): void;
}

const useInviteQueue = create<InviteQueueState>((set) => ({
  queue: [],
  add(invite) {
    set((s) =>
      s.queue.some((i) => i.id === invite.id) ? s : { queue: [invite, ...s.queue] },
    );
  },
  remove(id) {
    set((s) => ({ queue: s.queue.filter((i) => i.id !== id) }));
  },
  clear() {
    set({ queue: [] });
  },
}));

let wiredTo: unknown = null;

/** Idempotent per transport instance - mirrors wireNotificationsToTransport. */
// Accepting/declining from the BELL must also kill the corner card: drop any
// queued entry whose invite left the notifications store (live QA finding).
useNotificationsStore.subscribe((state, prev) => {
  const gone = prev.invites.filter((i) => !state.invites.some((n) => n.id === i.id));
  for (const inv of gone) useInviteQueue.getState().remove(inv.id);
});

function wireInviteQueue(): void {
  const t = getTransport();
  if (!t || t === wiredTo) return;
  wiredTo = t;
  t.on((event) => {
    if (event.type === "invite.direct") {
      useInviteQueue.getState().add(event.invite);
    }
  });
}

const VISIBLE_CARDS = 2;

function InviteCard({
  invite,
  onJoin,
  onDismiss,
  onCloseOnly,
  busy,
}: {
  invite: DirectInviteDTO;
  onJoin: () => void;
  onDismiss: () => void;
  onCloseOnly: () => void;
  busy: boolean;
}): ReactElement {
  return (
    <div className="rv-invite-card" role="status">
      <Avatar
        src={invite.from.avatarUrl ?? null}
        fallbackInitials={invite.from.displayName}
        fallbackColorSeed={invite.from.id}
        size={34}
      />
      <div className="head">
        <span className="rv-label" style={{ fontSize: "var(--t-2xs)" }}>
          Invite
        </span>
        <span className="line">
          <b style={{ fontWeight: 600 }}>
            {invite.from.handle ? `@${invite.from.handle}` : invite.from.displayName}
          </b>{" "}
          invited you to <b style={{ fontWeight: 600 }}>{invite.room.name}</b>
        </span>
        <span className="meta rv-mono">
          {invite.membersLive} member{invite.membersLive === 1 ? "" : "s"}
        </span>
      </div>
      <button type="button" className="rv-toast-close" aria-label="Close" onClick={onCloseOnly}>
        ×
      </button>
      <div className="actions">
        <button
          type="button"
          className="rv-btn"
          data-variant="primary"
          data-disabled={busy || undefined}
          style={{ height: "1.9rem", fontSize: "var(--t-xs)", flex: 1 }}
          onClick={() => {
            if (!busy) onJoin();
          }}
        >
          {busy ? "Joining…" : "Join room"}
        </button>
        <button
          type="button"
          className="rv-btn"
          data-variant="ghost"
          style={{ height: "1.9rem", fontSize: "var(--t-xs)" }}
          disabled={busy}
          onClick={onDismiss}
        >
          Dismiss
        </button>
      </div>
    </div>
  );
}

export function InviteQueue({
  onJoinRoom,
}: {
  onJoinRoom: (roomId: string) => void;
}): ReactElement | null {
  const serverUrl = useAuthStore((s) => s.serverUrl);
  const token = useAuthStore((s) => s.token);
  const queue = useInviteQueue((s) => s.queue);
  const [busyId, setBusyId] = useState<string | null>(null);

  // The transport is created by an App-level effect that may run after this
  // component mounts - poll cheaply until wired (idempotent ref-compare).
  useEffect(() => {
    wireInviteQueue();
    const t = window.setInterval(wireInviteQueue, 2000);
    return () => window.clearInterval(t);
  }, [token]);

  if (queue.length === 0) return null;

  const apiFor = (): ApiClient => {
    const api = new ApiClient(serverUrl);
    api.setToken(token);
    return api;
  };

  const join = async (invite: DirectInviteDTO): Promise<void> => {
    setBusyId(invite.id);
    try {
      const res = await apiFor().directInviteAccept(invite.id);
      useInviteQueue.getState().remove(invite.id);
      useNotificationsStore.getState().removeInvite(invite.id);
      onJoinRoom(res.roomId);
    } catch (e) {
      useInviteQueue.getState().remove(invite.id);
      pushToast({
        kind: "error",
        text: "Couldn't join that room",
        sub: e instanceof Error ? e.message : "invite may have expired",
      });
    } finally {
      setBusyId(null);
    }
  };

  const dismiss = async (invite: DirectInviteDTO): Promise<void> => {
    useInviteQueue.getState().remove(invite.id);
    useNotificationsStore.getState().removeInvite(invite.id);
    try {
      await apiFor().directInviteDecline(invite.id);
    } catch {
      /* transient popup - the bell reconciles on next refresh */
    }
  };

  const dismissAll = (): void => {
    const all = useInviteQueue.getState().queue;
    useInviteQueue.getState().clear();
    for (const inv of all) {
      useNotificationsStore.getState().removeInvite(inv.id);
      void apiFor()
        .directInviteDecline(inv.id)
        .catch(() => {});
    }
  };

  const visible = queue.slice(0, VISIBLE_CARDS);
  const overflow = queue.length - visible.length;

  return (
    <div className="rv-invite-queue">
      {visible.map((inv) => (
        <InviteCard
          key={inv.id}
          invite={inv}
          busy={busyId === inv.id}
          onJoin={() => void join(inv)}
          onDismiss={() => void dismiss(inv)}
          onCloseOnly={() => useInviteQueue.getState().remove(inv.id)}
        />
      ))}
      {queue.length > 1 && (
        <div className="rv-invite-more">
          <span className="count">
            {overflow > 0 ? `+ ${overflow} more invite${overflow === 1 ? "" : "s"} queued` : ""}
          </span>
          <button type="button" className="clear" onClick={dismissAll}>
            Dismiss all
          </button>
        </div>
      )}
    </div>
  );
}
