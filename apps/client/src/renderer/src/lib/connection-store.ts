import { create } from "zustand";

/**
 * App-wide WS connection health (system/connection-banners.html). The
 * ChatTransport singleton (chat-transport.ts) owns the socket and is the only
 * writer; the ConnectionBanner subscribes. No banner renders when healthy —
 * connection health only surfaces when degraded.
 */

export type ConnectionStatus = "idle" | "connecting" | "open" | "reconnecting";

interface ConnectionState {
  status: ConnectionStatus;
  /** Consecutive failed attempts since the socket was last open. */
  attempts: number;
  /** Epoch ms of the next scheduled reconnect, when status = reconnecting. */
  nextRetryAt: number | null;
  /** Epoch ms the socket last opened — "Last sync Ns ago". */
  lastOpenAt: number | null;
}

export const useConnectionStore = create<ConnectionState>(() => ({
  status: "idle",
  attempts: 0,
  nextRetryAt: null,
  lastOpenAt: null,
}));

/** Writer for chat-transport.ts (non-React module). */
export function setConnectionState(patch: Partial<ConnectionState>): void {
  useConnectionStore.setState(patch);
}
