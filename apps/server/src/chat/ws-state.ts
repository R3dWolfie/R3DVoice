import type { WebSocket } from "ws";
import type { ThreadType } from "./threads.js";

/**
 * In-memory subscription registry. Maps `${threadType}:${threadId}` → set of
 * sockets currently listening. Process-local (single-process server) — for
 * multi-process deployments, swap this for a Redis pub/sub backend.
 */

interface ConnectedSocket {
  socket: WebSocket;
  userId: string;
}

const subscriptions = new Map<string, Set<ConnectedSocket>>();

// Per-user online presence: userId → set of currently-connected sockets.
// A user is "online" iff they have at least one open WebSocket. Tracks here
// so /friends can return isOnline without opening a socket of its own.
const onlineSockets = new Map<string, Set<ConnectedSocket>>();

export function markOnline(conn: ConnectedSocket): void {
  let set = onlineSockets.get(conn.userId);
  if (!set) {
    set = new Set();
    onlineSockets.set(conn.userId, set);
  }
  set.add(conn);
}

export function markOffline(conn: ConnectedSocket): void {
  const set = onlineSockets.get(conn.userId);
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) onlineSockets.delete(conn.userId);
}

export function isUserOnline(userId: string): boolean {
  const set = onlineSockets.get(userId);
  return set !== undefined && set.size > 0;
}

function key(threadType: ThreadType, threadId: string): string {
  return `${threadType}:${threadId}`;
}

export function subscribe(
  threadType: ThreadType,
  threadId: string,
  conn: ConnectedSocket,
): void {
  const k = key(threadType, threadId);
  let set = subscriptions.get(k);
  if (!set) {
    set = new Set();
    subscriptions.set(k, set);
  }
  set.add(conn);
}

export function unsubscribe(
  threadType: ThreadType,
  threadId: string,
  conn: ConnectedSocket,
): void {
  const set = subscriptions.get(key(threadType, threadId));
  if (!set) return;
  set.delete(conn);
  if (set.size === 0) subscriptions.delete(key(threadType, threadId));
}

export function unsubscribeAll(conn: ConnectedSocket): void {
  for (const [k, set] of subscriptions) {
    set.delete(conn);
    if (set.size === 0) subscriptions.delete(k);
  }
}

export function broadcastToThread(
  threadType: ThreadType,
  threadId: string,
  payload: unknown,
  excludeUserId?: string,
): void {
  const set = subscriptions.get(key(threadType, threadId));
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const conn of set) {
    if (excludeUserId !== undefined && conn.userId === excludeUserId) continue;
    try {
      conn.socket.send(data);
    } catch {
      // Socket might be in a half-closed state — drop silently. The close
      // handler will clean it up.
    }
  }
}

/**
 * Per-user direct event delivery. Use for notifications targeted at a
 * specific user (mention, friend request, invite redeemed) — events the
 * recipient should see regardless of which thread they're currently
 * subscribed to. Iterates all of that user's open sockets.
 */
export function sendToUser(userId: string, payload: unknown): void {
  const set = onlineSockets.get(userId);
  if (!set || set.size === 0) return;
  const data = JSON.stringify(payload);
  for (const conn of set) {
    try {
      conn.socket.send(data);
    } catch {
      // half-closed; close handler cleans up
    }
  }
}

export type { ConnectedSocket };
