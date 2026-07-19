import { AccessToken, RoomServiceClient } from "livekit-server-sdk";
import { getConfig } from "./config.js";

export interface MintArgs {
  userId: string;
  displayName: string;
  roomId: string;
}

export async function mintLiveKitToken(args: MintArgs): Promise<string> {
  const cfg = getConfig();
  const at = new AccessToken(cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET, {
    identity: args.userId,
    name: args.displayName,
    ttl: 60 * 60, // 1 hour
  });
  at.addGrant({
    room: args.roomId,
    roomJoin: true,
    canPublish: true,
    canSubscribe: true,
    canPublishData: true,
  });
  return at.toJwt();
}

let cachedRoomService: RoomServiceClient | null = null;
function getRoomService(): RoomServiceClient {
  if (cachedRoomService) return cachedRoomService;
  const cfg = getConfig();
  // RoomServiceClient expects an HTTP base URL; LIVEKIT_URL is the WS URL.
  const httpUrl = cfg.LIVEKIT_URL.replace(/^wss?:\/\//, (m) =>
    m === "wss://" ? "https://" : "http://",
  );
  cachedRoomService = new RoomServiceClient(httpUrl, cfg.LIVEKIT_API_KEY, cfg.LIVEKIT_API_SECRET);
  return cachedRoomService;
}

/**
 * Disconnect a participant from a LiveKit room. Used when an owner removes a
 * member - kicks them in real time so they don't keep streaming. Best-effort:
 * if the participant isn't currently connected, the call no-ops.
 */
export async function kickParticipant(roomId: string, userId: string): Promise<void> {
  try {
    await getRoomService().removeParticipant(roomId, userId);
  } catch {
    /* not connected, or LiveKit unreachable - caller doesn't care */
  }
}

/**
 * Tear down the LiveKit room itself, disconnecting all participants. Called
 * when the owner deletes the room in our application - we want everyone
 * connected to be kicked promptly, not just have new joins blocked.
 */
export async function deleteLiveKitRoom(roomId: string): Promise<void> {
  try {
    await getRoomService().deleteRoom(roomId);
  } catch {
    /* room may not exist on LiveKit (no one ever connected) - ignore */
  }
}
