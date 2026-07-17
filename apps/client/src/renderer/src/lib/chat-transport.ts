import type {
  ChatMessageDTO,
  ChatThreadType,
  ChatWsCommand,
  ChatWsEvent,
} from "@r3dvoice/shared";
import type { ApiClient } from "./api.js";
import { routeNotification } from "./notification-router.js";
import { prefsActions } from "./prefs-singleton.js";
import { useUnreadStore } from "./unread-store.js";

/** Snapshot of the authenticated user, kept current by the renderer shell. */
interface UserSnapshot {
  id: string;
  dndUntil?: string | null;
}

let _currentUser: UserSnapshot | null = null;

/** Called by the React shell whenever the authenticated user changes. */
export function setCurrentUserForNotifications(user: UserSnapshot | null): void {
  _currentUser = user;
}

/**
 * Tracks which thread the user is currently looking at. When a `message` /
 * `chat.mention` arrives for THIS thread, we don't bump unread or fire a
 * notification — the user is already reading the conversation. Discord does
 * the same.
 */
let _viewingThread: { threadType: ChatThreadType; threadId: string } | null = null;

export function setCurrentlyViewingThread(
  t: { threadType: ChatThreadType; threadId: string } | null,
): void {
  _viewingThread = t;
}

function isViewingThread(threadType: ChatThreadType, threadId: string): boolean {
  return (
    _viewingThread !== null &&
    _viewingThread.threadType === threadType &&
    _viewingThread.threadId === threadId
  );
}

type Listener = (event: ChatWsEvent) => void;

/**
 * Manages a single WebSocket connection for chat events. Auth via the
 * Sec-WebSocket-Protocol subprotocol "r3dvoice.bearer.<jwt>" — the only
 * browser-WebSocket way to ship a token without leaking it in the URL.
 *
 * Owns reconnect on transient drops with exponential backoff.
 * Subscriptions are remembered so we re-subscribe after a reconnect.
 */
export class ChatTransport {
  private ws: WebSocket | null = null;
  private listeners = new Set<Listener>();
  private subscribed = new Set<string>(); // "type:id"
  private serverUrl: string;
  private token: string;
  private closed = false;
  private reconnectDelay = 1000;
  private heartbeatTimer: number | null = null;
  private _muteCache = new Map<string, "all" | "mentions" | "none">();
  private _api: ApiClient | null = null;

  constructor(serverUrl: string, token: string, api?: ApiClient) {
    this.serverUrl = serverUrl;
    this.token = token;
    this._api = api ?? null;
  }

  /** Public read so the singleton accessor can detect token/server changes. */
  get currentToken(): string { return this.token; }
  get currentServerUrl(): string { return this.serverUrl; }

  start(): void {
    if (this.closed) return;
    this.connect();
  }

  stop(): void {
    this.closed = true;
    if (this.heartbeatTimer != null) {
      window.clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.ws) {
      try {
        this.ws.close();
      } catch {
        /* noop */
      }
      this.ws = null;
    }
  }

  on(cb: Listener): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  subscribe(threadType: ChatThreadType, threadId: string): void {
    this.subscribed.add(`${threadType}:${threadId}`);
    this.sendCmd({ type: "subscribe", threadType, threadId });
  }

  unsubscribe(threadType: ChatThreadType, threadId: string): void {
    this.subscribed.delete(`${threadType}:${threadId}`);
    this.sendCmd({ type: "unsubscribe", threadType, threadId });
  }

  /**
   * Returns the cached mute level for a thread, or fetches it lazily on miss.
   * Defaults to "all" when api isn't wired or the fetch fails.
   */
  async getMuteLevel(
    threadType: ChatThreadType,
    threadId: string,
  ): Promise<"all" | "mentions" | "none"> {
    const key = `${threadType}:${threadId}`;
    const cached = this._muteCache.get(key);
    if (cached !== undefined) return cached;
    if (!this._api) return "all";
    try {
      const r = await this._api.getMute(threadType, threadId);
      this._muteCache.set(key, r.level);
      return r.level;
    } catch {
      return "all";
    }
  }

  /** Drop the cached value for a thread — call after a setMute mutation. */
  invalidateMute(threadType: ChatThreadType, threadId: string): void {
    this._muteCache.delete(`${threadType}:${threadId}`);
  }

  private connect(): void {
    const wsUrl = httpToWs(this.serverUrl) + "/ws";
    let ws: WebSocket;
    try {
      ws = new WebSocket(wsUrl, [`r3dvoice.bearer.${this.token}`]);
    } catch {
      this.scheduleReconnect();
      return;
    }
    this.ws = ws;

    ws.addEventListener("open", () => {
      this.reconnectDelay = 1000;
      // Re-subscribe everything we cared about.
      for (const k of this.subscribed) {
        const [t, ...rest] = k.split(":");
        const id = rest.join(":");
        if (t === "room" || t === "dm") {
          this.sendCmd({ type: "subscribe", threadType: t, threadId: id });
        }
      }
      // Heartbeat every 25s — keeps NAT mappings + tunnel alive.
      this.heartbeatTimer = window.setInterval(() => {
        this.sendCmd({ type: "ping" });
      }, 25000);
    });

    ws.addEventListener("message", (msg) => {
      try {
        const event = JSON.parse(typeof msg.data === "string" ? msg.data : "") as ChatWsEvent;
        this.listeners.forEach((l) => l(event));

        const me = _currentUser;
        if (!me) return;

        // Bump unread on incoming messages — both regular `message` events
        // (delivered to thread subscribers) AND `chat.mention` events
        // (delivered directly to the mentioned user even if they're not
        // subscribed). Skip when the user is currently looking at the
        // thread — they don't need a badge for a thread they're reading.
        if (event.type === "message" && event.message.authorId !== me.id) {
          if (!isViewingThread(event.message.threadType, event.message.threadId)) {
            useUnreadStore.getState().bump(event.message.threadType, event.message.threadId);
          }
        } else if (event.type === "chat.mention" && event.message.authorId !== me.id) {
          if (!isViewingThread(event.message.threadType, event.message.threadId)) {
            useUnreadStore.getState().bump(event.message.threadType, event.message.threadId);
          }
        }

        // Route through the notification filter. Suppress notifications
        // for the currently-viewed thread the same way.
        const isMessageEvent = event.type === "message" || event.type === "chat.mention";
        const suppressForActiveThread =
          isMessageEvent &&
          (event as { message: { threadType: ChatThreadType; threadId: string } }).message &&
          isViewingThread(
            (event as { message: { threadType: ChatThreadType; threadId: string } }).message.threadType,
            (event as { message: { threadType: ChatThreadType; threadId: string } }).message.threadId,
          );
        if (suppressForActiveThread) return;

        void routeNotification(event, {
          selfUserId: me.id,
          dndUntil: me.dndUntil ? new Date(me.dndUntil) : null,
          prefs: {
            dmBanners: prefsActions().dmBanners,
            dmPreviews: prefsActions().dmPreviews,
          },
          getMuteLevel: async (threadType, threadId) => this.getMuteLevel(threadType, threadId),
          fireOSNotification: async (p) => {
            try { await window.r3dvoice.notify({ title: p.title, body: p.body }); } catch { /* */ }
          },
        });
      } catch {
        /* drop malformed */
      }
    });

    ws.addEventListener("close", (ev) => {
      if (this.heartbeatTimer != null) {
        window.clearInterval(this.heartbeatTimer);
        this.heartbeatTimer = null;
      }
      this.ws = null;
      // 4401 = auth failure (server rejected our subprotocol token). Reconnect
      // loops would spin forever on a stale token — bail and let the auth flow
      // (re-login, re-hydrate) re-establish the singleton via ensureTransport.
      if (ev.code === 4401) {
        this.closed = true;
        return;
      }
      if (!this.closed) this.scheduleReconnect();
    });

    ws.addEventListener("error", () => {
      // Let close handler run; nothing to do here.
    });
  }

  private sendCmd(cmd: ChatWsCommand): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    try {
      this.ws.send(JSON.stringify(cmd));
    } catch {
      /* socket may be closing */
    }
  }

  private scheduleReconnect(): void {
    const delay = Math.min(this.reconnectDelay, 30000);
    window.setTimeout(() => {
      if (!this.closed) this.connect();
    }, delay);
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000);
  }
}

function httpToWs(url: string): string {
  if (url.startsWith("https://")) return "wss://" + url.slice("https://".length);
  if (url.startsWith("http://")) return "ws://" + url.slice("http://".length);
  return url;
}

// ---------------------------------------------------------------------------
// Module-level singleton.
//
// Before v0.8.1 every RoomChatPanel mount instantiated its own ChatTransport,
// which meant the WS connection only existed when a chat panel was open. WS
// events targeted at the user (chat.mention, friend.request, friend.accepted,
// invite.redeemed, presence.update) silently dropped any time the user wasn't
// viewing a thread — so OS notifications and friend-event UI updates were
// effectively dead.
//
// The fix: one transport per logged-in user, kept alive for the entire
// session. RoomChatPanel borrows the singleton for thread-specific
// subscriptions but doesn't own its lifecycle. App.tsx wires connect/
// disconnect to the auth state.
// ---------------------------------------------------------------------------

let _instance: ChatTransport | null = null;

/**
 * Get (or create) the app-wide ChatTransport for the given user. Idempotent
 * — calling it again with the same serverUrl+token returns the existing
 * instance; calling with different credentials tears down the old one first.
 */
export function ensureTransport(serverUrl: string, token: string, api?: ApiClient): ChatTransport {
  if (
    _instance !== null &&
    _instance.currentToken === token &&
    _instance.currentServerUrl === serverUrl
  ) {
    return _instance;
  }
  if (_instance !== null) {
    _instance.stop();
  }
  _instance = new ChatTransport(serverUrl, token, api);
  _instance.start();
  return _instance;
}

/** Tear down the singleton — called on logout. */
export function disconnectTransport(): void {
  if (_instance !== null) {
    _instance.stop();
    _instance = null;
  }
}

/** Read the current singleton without creating one. */
export function getTransport(): ChatTransport | null {
  return _instance;
}

export type { ChatMessageDTO };
