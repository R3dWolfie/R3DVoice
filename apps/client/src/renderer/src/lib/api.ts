import type {
  AuthResponse,
  CreateRoomRequest,
  LoginRequest,
  LoginResponse,
  RegisterRequest as _SharedRegisterRequest,
  RoomDTO,
  RoomListResponse,
  RoomMemberDTO,
  UpdateRoomRequest,
  UserDTO,
  LiveKitTokenResponse,
  ErrorResponse,
  TotpVerifyRequest,
  TotpEnrollStartResponse,
  ChatHistoryResponse,
  ChatSendRequest,
  ChatSendResponse,
  ChatThreadType,
  DmThreadsResponse,
  ChatMessageDTO,
  FriendsListResponse,
  FriendRequestResponse,
  InviteDTO,
  UnreadCountsResponse,
  MuteLevel,
} from "@r3dvoice/shared";

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "ApiError";
    this.code = code;
    this.status = status;
  }
}

export class ApiClient {
  private baseUrl: string;
  private token: string | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/$/, "");
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "");
  }

  setToken(token: string | null): void {
    this.token = token;
  }

  private async request<TBody, TRes>(
    method: "GET" | "POST" | "PATCH" | "DELETE",
    path: string,
    body?: TBody,
  ): Promise<TRes> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;

    let response: Response;
    try {
      const init: RequestInit = {
        method,
        headers,
      };
      if (body !== undefined) {
        init.body = JSON.stringify(body);
      }
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new ApiError("NETWORK", err instanceof Error ? err.message : "network error", 0);
    }

    if (response.status === 204) {
      return undefined as TRes;
    }

    const contentType = response.headers.get("content-type") ?? "";
    const isJson = contentType.includes("application/json");
    const payload: unknown = isJson ? await response.json() : await response.text();

    if (!response.ok) {
      if (isJson && payload && typeof payload === "object" && "error" in payload) {
        const err = (payload as ErrorResponse).error;
        throw new ApiError(err.code, err.message, response.status);
      }
      throw new ApiError("HTTP_ERROR", `request failed with ${response.status}`, response.status);
    }

    return payload as TRes;
  }

  // Auth — register payload allows an optional E2EE public key.
  register(body: _SharedRegisterRequest & { e2eePublicKey?: string }): Promise<AuthResponse> {
    return this.request("POST", "/auth/register", body);
  }
  setE2eePublicKey(e2eePublicKey: string): Promise<void> {
    return this.request("POST", "/auth/e2ee/public-key", { e2eePublicKey });
  }
  getUserPublicKey(userId: string): Promise<{ id: string; displayName: string; publicKey: string | null }> {
    return this.request("GET", `/users/${encodeURIComponent(userId)}/public-key`);
  }
  login(body: LoginRequest): Promise<LoginResponse> {
    return this.request("POST", "/auth/login", body);
  }
  loginTotp(body: TotpVerifyRequest): Promise<AuthResponse> {
    return this.request("POST", "/auth/login/totp", body);
  }
  logout(): Promise<void> {
    return this.request("POST", "/auth/logout");
  }
  me(): Promise<UserDTO> {
    return this.request("GET", "/me");
  }
  updateMe(patch: { avatarUrl?: string | null }): Promise<UserDTO> {
    return this.request("PATCH", "/me", patch);
  }
  twoFAEnrollStart(): Promise<TotpEnrollStartResponse> {
    return this.request("POST", "/auth/2fa/enroll-start");
  }
  twoFAEnrollVerify(code: string): Promise<{ enabled: true }> {
    return this.request("POST", "/auth/2fa/enroll-verify", { code });
  }
  twoFADisable(password: string): Promise<{ enabled: false }> {
    return this.request("POST", "/auth/2fa/disable", { password });
  }

  // Rooms
  listRooms(): Promise<RoomListResponse> {
    return this.request("GET", "/rooms");
  }
  getRoom(id: string): Promise<RoomDTO> {
    return this.request("GET", `/rooms/${encodeURIComponent(id)}`);
  }
  createRoom(body: CreateRoomRequest): Promise<RoomDTO> {
    return this.request("POST", "/rooms", body);
  }
  updateRoom(id: string, body: UpdateRoomRequest): Promise<RoomDTO> {
    return this.request("PATCH", `/rooms/${encodeURIComponent(id)}`, body);
  }
  deleteRoom(id: string): Promise<void> {
    return this.request("DELETE", `/rooms/${encodeURIComponent(id)}`);
  }
  transferRoomOwnership(id: string, newOwnerId: string): Promise<RoomDTO> {
    return this.request("POST", `/rooms/${encodeURIComponent(id)}/transfer`, { newOwnerId });
  }
  listRoomMembers(id: string): Promise<RoomMemberDTO[]> {
    return this.request("GET", `/rooms/${encodeURIComponent(id)}/members`);
  }
  inviteRoomMember(id: string, userId: string): Promise<RoomMemberDTO> {
    return this.request("POST", `/rooms/${encodeURIComponent(id)}/members`, { userId });
  }
  removeRoomMember(id: string, userId: string): Promise<void> {
    return this.request(
      "DELETE",
      `/rooms/${encodeURIComponent(id)}/members/${encodeURIComponent(userId)}`,
    );
  }
  leaveRoom(id: string): Promise<void> {
    return this.request("DELETE", `/rooms/${encodeURIComponent(id)}/membership`);
  }
  mintLiveKitToken(roomId: string): Promise<LiveKitTokenResponse> {
    return this.request("POST", `/rooms/${encodeURIComponent(roomId)}/token`);
  }

  // Chat
  chatHistory(
    threadType: ChatThreadType,
    threadId: string,
    opts: { before?: string; limit?: number } = {},
  ): Promise<ChatHistoryResponse> {
    const params = new URLSearchParams({ threadType, threadId });
    if (opts.before) params.set("before", opts.before);
    if (opts.limit) params.set("limit", String(opts.limit));
    return this.request("GET", `/chat/messages?${params.toString()}`);
  }
  chatSend(body: ChatSendRequest): Promise<ChatSendResponse> {
    return this.request("POST", "/chat/messages", body);
  }
  chatEdit(id: string, body: string): Promise<ChatSendResponse> {
    return this.requestWithMethod("PATCH", `/chat/messages/${encodeURIComponent(id)}`, { body });
  }
  chatDelete(id: string): Promise<void> {
    return this.requestWithMethod("DELETE", `/chat/messages/${encodeURIComponent(id)}`);
  }
  dmThreads(): Promise<DmThreadsResponse> {
    return this.request("GET", "/chat/dm-threads");
  }

  // Friends
  friends(): Promise<FriendsListResponse> {
    return this.request("GET", "/friends");
  }
  friendRequest(email: string): Promise<FriendRequestResponse> {
    return this.request("POST", "/friends/request", { email });
  }
  friendAccept(friendshipId: string): Promise<void> {
    return this.request("POST", `/friends/${encodeURIComponent(friendshipId)}/accept`);
  }
  friendReject(friendshipId: string): Promise<void> {
    return this.request("POST", `/friends/${encodeURIComponent(friendshipId)}/reject`);
  }

  // Handle
  setMyHandle(handle: string): Promise<{ id: string; handle: string; displayName: string; email: string }> {
    return this.request("POST", "/me/handle", { handle });
  }

  getUserByHandle(handle: string): Promise<{ id: string; handle: string; displayName: string }> {
    return this.request("GET", `/users/by-handle/${encodeURIComponent(handle)}`);
  }

  friendRequestByHandle(handle: string): Promise<{ friendshipId: string; status: string; user: { id: string; handle: string | null; displayName: string } }> {
    return this.request("POST", "/friends/request-by-handle", { handle });
  }

  // Invites
  createInvite(input: { kind: "room" | "friend"; targetRoomId?: string; expiresAt?: string | null; maxUses?: number | null }): Promise<unknown> {
    return this.request("POST", "/invites", input);
  }

  listMyInvites(): Promise<{ invites: InviteDTO[] }> {
    return this.request("GET", "/invites") as Promise<{ invites: InviteDTO[] }>;
  }

  async revokeInvite(id: string): Promise<void> {
    await this.request("DELETE", `/invites/${encodeURIComponent(id)}`);
  }

  getInvitePublic(code: string): Promise<unknown> {
    return this.request("GET", `/invites/${encodeURIComponent(code)}`);
  }

  getInviteFull(code: string): Promise<unknown> {
    return this.request("GET", `/invites/${encodeURIComponent(code)}/full`);
  }

  redeemInvite(code: string): Promise<{ kind: "room" | "friend"; redirectTo: string }> {
    return this.request("POST", `/invites/${encodeURIComponent(code)}/redeem`);
  }

  // Unread / mute / DND / presence
  async markRead(threadType: "room" | "dm", threadId: string, lastReadAt?: string): Promise<void> {
    const body: { threadType: string; threadId: string; lastReadAt?: string } = { threadType, threadId };
    if (lastReadAt) body.lastReadAt = lastReadAt;
    await this.request("POST", "/chat/read", body);
  }

  getUnread(): Promise<UnreadCountsResponse> {
    return this.request("GET", "/chat/unread");
  }

  getMute(threadType: "room" | "dm", threadId: string): Promise<{ threadType: string; threadId: string; level: MuteLevel; mutedUntil: string | null }> {
    return this.request("GET", `/chat/threads/${threadType}/${encodeURIComponent(threadId)}/mute`);
  }

  async setMute(threadType: "room" | "dm", threadId: string, level: MuteLevel, mutedUntil?: string | null): Promise<void> {
    const body: { level: MuteLevel; mutedUntil?: string | null } = { level };
    if (mutedUntil !== undefined) body.mutedUntil = mutedUntil;
    await this.request("PATCH", `/chat/threads/${threadType}/${encodeURIComponent(threadId)}/mute`, body);
  }

  async setDnd(until: string | null): Promise<void> {
    await this.request("PATCH", "/me/dnd", { until });
  }

  async setPresence(roomId: string | null): Promise<void> {
    await this.request("POST", "/me/presence", { roomId });
  }

  // Internal helper for HTTP methods beyond GET/POST.
  private async requestWithMethod<TBody, TRes>(
    method: "PATCH" | "DELETE",
    path: string,
    body?: TBody,
  ): Promise<TRes> {
    const headers: Record<string, string> = {};
    if (body !== undefined) headers["content-type"] = "application/json";
    if (this.token) headers["authorization"] = `Bearer ${this.token}`;
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    let response: Response;
    try {
      response = await fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      throw new ApiError("NETWORK", err instanceof Error ? err.message : "network error", 0);
    }
    if (response.status === 204) return undefined as TRes;
    const ct = response.headers.get("content-type") ?? "";
    const isJson = ct.includes("application/json");
    const payload: unknown = isJson ? await response.json() : await response.text();
    if (!response.ok) {
      if (isJson && payload && typeof payload === "object" && "error" in payload) {
        const err = (payload as ErrorResponse).error;
        throw new ApiError(err.code, err.message, response.status);
      }
      throw new ApiError("HTTP_ERROR", `request failed with ${response.status}`, response.status);
    }
    return payload as TRes;
  }
}

export type { ChatMessageDTO };
