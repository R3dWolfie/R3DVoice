import { create } from "zustand";
import type { FriendDTO, MentionFeedItemDTO, DirectInviteDTO } from "@r3dvoice/shared";
import type { ApiClient } from "./api.js";
import { getTransport } from "./chat-transport.js";

/**
 * Bell-panel state (4.15): mentions history + directed room invites from
 * /notifications/feed, plus incoming friend requests from /friends. Lives in
 * a store (not the panel) so the bell badge in the icon column stays live
 * while the panel is closed.
 */
interface NotificationsState {
  seenAt: string | null;
  mentions: MentionFeedItemDTO[];
  invites: DirectInviteDTO[];
  friendRequests: FriendDTO[];
  loaded: boolean;
  refresh(): Promise<void>;
  markAllRead(): Promise<void>;
  removeInvite(id: string): void;
  removeFriendRequest(friendshipId: string): void;
}

// The auth store is React-context-scoped, so components hand us an api
// factory instead of this module reaching into auth state.
let apiFactory: (() => ApiClient) | null = null;

export function configureNotificationsApi(factory: () => ApiClient): void {
  apiFactory = factory;
}

function api(): ApiClient | null {
  return apiFactory ? apiFactory() : null;
}

export const useNotificationsStore = create<NotificationsState>((set) => ({
  seenAt: null,
  mentions: [],
  invites: [],
  friendRequests: [],
  loaded: false,

  async refresh() {
    const c = api();
    if (!c) return;
    try {
      const [feed, friends] = await Promise.all([c.notificationsFeed(), c.friends()]);
      set({
        seenAt: feed.seenAt,
        mentions: feed.mentions,
        invites: feed.invites,
        friendRequests: friends.friends.filter((f) => f.status === "pending-incoming"),
        loaded: true,
      });
    } catch {
      /* bell is passive — keep stale state on error */
    }
  },

  async markAllRead() {
    const now = new Date().toISOString();
    set({ seenAt: now }); // optimistic — the watermark only moves forward
    try {
      await api()?.notificationsReadAll();
    } catch {
      /* next refresh reconciles */
    }
  },

  removeInvite(id) {
    set((s) => ({ invites: s.invites.filter((i) => i.id !== id) }));
  },

  removeFriendRequest(friendshipId) {
    set((s) => ({ friendRequests: s.friendRequests.filter((f) => f.friendshipId !== friendshipId) }));
  },
}));

/** Count of rows the bell badge should show (deck 4.15 "7 unread"). */
export function unseenCount(s: Pick<NotificationsState, "seenAt" | "mentions" | "invites" | "friendRequests">): number {
  const seen = s.seenAt ? Date.parse(s.seenAt) : 0;
  const freshMentions = s.mentions.filter((m) => Date.parse(m.message.createdAt) > seen).length;
  return freshMentions + s.invites.length + s.friendRequests.length;
}

let wiredTo: unknown = null;

/** Idempotent per transport instance: subscribe the store to live WS events.
 *  Re-wires automatically if the transport was recreated (re-login). */
export function wireNotificationsToTransport(): void {
  const t = getTransport();
  if (!t || t === wiredTo) return;
  wiredTo = t;
  t.on((event) => {
    if (
      event.type === "chat.mention" ||
      event.type === "invite.direct" ||
      event.type === "friend.request" ||
      event.type === "friend.accepted"
    ) {
      void useNotificationsStore.getState().refresh();
    }
  });
}
