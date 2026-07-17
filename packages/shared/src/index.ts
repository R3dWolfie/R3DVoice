// Auth DTOs
export interface RegisterRequest {
  email: string;
  password: string;
  displayName: string;
}

export interface LoginRequest {
  email: string;
  password: string;
}

export interface AuthResponse {
  token: string;
  user: UserDTO;
}

/** /auth/login response when the user has 2FA enabled. */
export interface TotpRequiredResponse {
  requiresTotp: true;
  twoFactorToken: string;
}

export type LoginResponse = AuthResponse | TotpRequiredResponse;

export interface TotpVerifyRequest {
  twoFactorToken: string;
  code: string;
}

export interface TotpEnrollStartResponse {
  secret: string;
  otpAuthUrl: string;
  qrDataUrl: string;
}

export interface UserDTO {
  id: string;
  email: string;
  displayName: string;
  handle?: string | null;
  avatarUrl?: string | null;
  totpEnabled?: boolean;
  dndUntil?: string | null;
}

// Room DTOs
export interface CreateRoomRequest {
  name: string;
  isPublic?: boolean;
  description?: string;
}

export interface UpdateRoomRequest {
  name?: string;
  isPublic?: boolean;
  description?: string | null;
}

export interface InviteMemberRequest {
  userId: string;
}

export interface TransferOwnershipRequest {
  newOwnerId: string;
}

export interface RoomDTO {
  id: string;
  name: string;
  description: string | null;
  ownerId: string;
  isPublic: boolean;
  createdAt: string; // ISO 8601
  isOwner: boolean;
  lastJoined: string | null; // ISO 8601 or null if never joined
  /** Users currently in the call (live presence count). */
  inCall?: number;
}

export interface RoomMemberDTO {
  userId: string;
  displayName: string;
  isOwner: boolean;
  joinedAt: string; // ISO 8601
  lastJoined: string; // ISO 8601
}

export interface RoomListResponse {
  owned: RoomDTO[];
  recent: RoomDTO[];
}

export interface PublicRoomDTO {
  id: string;
  name: string;
  description: string | null;
  memberCount: number;
  /** Users currently in the call (live presence count). */
  inCall: number;
  createdAt: string;
}

export interface PublicRoomsResponse {
  rooms: PublicRoomDTO[];
}

// Token DTOs
export interface LiveKitTokenResponse {
  token: string;
  url: string; // wss://livekit-host
  roomId: string;
}

// Chat DTOs
export type ChatThreadType = "room" | "dm";

export interface ChatMessageDTO {
  id: string;
  threadType: ChatThreadType;
  threadId: string;
  authorId: string;
  authorName: string;
  /** null when soft-deleted */
  body: string | null;
  createdAt: string; // ISO 8601
  editedAt: string | null;
  deletedAt: string | null;
  /** Set while pinned (2.5p). */
  pinnedAt?: string | null;
  mentions?: string[];
}

export interface ChatHistoryResponse {
  messages: ChatMessageDTO[];
}

export interface ChatSendRequest {
  threadType: ChatThreadType;
  threadId: string;
  body: string;
}

export interface ChatSendResponse {
  message: ChatMessageDTO;
}

export interface DmThreadEntry {
  threadId: string;
  lastMessage: ChatMessageDTO;
  /** Identity of the OTHER participant (not the caller). */
  otherParticipant: {
    id: string;
    handle: string | null;
    displayName: string;
  };
}

export interface DmThreadsResponse {
  threads: DmThreadEntry[];
}

/** Server → client WebSocket events. */
export type ChatWsEvent =
  | { type: "ready"; userId: string }
  | { type: "message"; message: ChatMessageDTO }
  | { type: "edited"; message: ChatMessageDTO }
  | { type: "deleted"; id: string; threadType: ChatThreadType; threadId: string }
  | { type: "pong" }
  | { type: "error"; code: string; threadId?: string }
  | { type: "chat.mention"; message: ChatMessageDTO }
  | { type: "friend.request"; from: { id: string; handle: string | null; displayName: string } }
  | { type: "friend.accepted"; by: { id: string; handle: string | null; displayName: string } }
  | { type: "invite.redeemed"; code: string; by: { id: string; handle: string | null; displayName: string }; kind: InviteKind; targetRoomId: string | null }
  | { type: "presence.update"; userId: string; currentRoom: { id: string; name: string } | null }
  | { type: "chat.typing"; threadType: ChatThreadType; threadId: string; userId: string }
  | { type: "pinned"; message: ChatMessageDTO }
  | { type: "unpinned"; id: string; threadType: ChatThreadType; threadId: string };

/** Client → server WebSocket frames. */
export type ChatWsCommand =
  | { type: "subscribe"; threadType: ChatThreadType; threadId: string }
  | { type: "unsubscribe"; threadType: ChatThreadType; threadId: string }
  | { type: "ping" }
  | { type: "typing"; threadType: ChatThreadType; threadId: string };

// Friends DTOs
export type FriendStatus = "pending-incoming" | "pending-outgoing" | "accepted" | "blocked";

export interface FriendDTO {
  friendshipId: string;
  status: FriendStatus;
  user: {
    id: string;
    displayName: string;
    email: string;
    handle?: string | null;
    avatarUrl?: string | null;
    /** Where this friend is hanging out right now, if anywhere. */
    currentRoom?: { id: string; name: string } | null;
  };
  isOnline: boolean;
  requestedAt: string;
  respondedAt: string | null;
}

export interface FriendsListResponse {
  friends: FriendDTO[];
}

export interface FriendRequestRequest {
  email: string;
}

export interface FriendRequestResponse {
  friendshipId: string;
  status: "pending-outgoing";
  user: { id: string; displayName: string; email: string };
}

// Error shape returned on any non-2xx
export interface ErrorResponse {
  error: {
    code: string;     // e.g. "VALIDATION_ERROR"
    message: string;  // human readable
  };
}

// Invite DTOs and validation schemas
import { z } from "zod";

export const userHandleSchema = z
  .string()
  .min(3, "handle must be at least 3 characters")
  .max(24, "handle must be at most 24 characters")
  .regex(/^[A-Za-z0-9_]+$/, "handle may only contain letters, digits, and underscores");

export type UserHandle = z.infer<typeof userHandleSchema>;

export const inviteKindSchema = z.enum(["room", "friend"]);
export type InviteKind = z.infer<typeof inviteKindSchema>;

export const createInviteSchema = z
  .object({
    kind: inviteKindSchema,
    targetRoomId: z.string().uuid().optional(),
    expiresAt: z.string().datetime().nullable().optional(),
    maxUses: z.number().int().positive().nullable().optional(),
  })
  .refine(
    (v: any) => (v.kind === "room") === (v.targetRoomId !== undefined),
    { message: "targetRoomId required for kind='room' and forbidden for kind='friend'" },
  );

export interface InviteDTO {
  id: string;
  code: string;
  kind: InviteKind;
  creatorId: string;
  targetRoomId: string | null;
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
  createdAt: string;
}

export interface InvitePublicMetadataDTO {
  code: string;
  kind: InviteKind;
  creator: { handle: string; displayName: string };
  expiresAt: string | null;
  maxUses: number | null;
  uses: number;
  revokedAt: string | null;
}

export interface InviteFullMetadataDTO extends InvitePublicMetadataDTO {
  targetRoom?: { id: string; name: string; memberCount: number };
}

export interface InviteRedeemResultDTO {
  kind: InviteKind;
  redirectTo: string; // e.g. "/rooms/<id>" or "/dms"
}

// Notification + presence DTOs

export type MuteLevel = "all" | "mentions" | "none";

export const muteLevelSchema = z.enum(["all", "mentions", "none"]);

export const setMuteSchema = z.object({
  level: muteLevelSchema,
  mutedUntil: z.string().datetime().nullable().optional(),
});

export const markReadSchema = z.object({
  threadType: z.enum(["room", "dm"]),
  threadId: z.string().min(1),
  lastReadAt: z.string().datetime().optional(),
});

export const setDndSchema = z.object({
  until: z.string().datetime().nullable().optional(),
});

export const setPresenceSchema = z.object({
  roomId: z.string().nullable(),
});

export const updateMeSchema = z.object({
  avatarUrl: z
    .string()
    .url()
    .max(2048)
    .startsWith("https://")
    .nullable()
    .optional(),
  displayName: z.string().trim().min(1).max(50).optional(),
});

export type UpdateMeRequest = z.infer<typeof updateMeSchema>;

export interface UnreadCountsResponse {
  /** Map keyed by `${threadType}:${threadId}` → count of unread messages. */
  counts: Record<string, number>;
  totalUnread: number;
}

export interface ThreadMuteDTO {
  threadType: ChatThreadType;
  threadId: string;
  level: MuteLevel;
  mutedUntil: string | null;
}
