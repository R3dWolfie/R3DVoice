-- Track when a user was last online (final WebSocket closed) so the friends
-- list can render "last seen 2h ago". Nullable/additive — existing rows keep
-- NULL until their next disconnect.
ALTER TABLE "User" ADD COLUMN "lastSeenAt" DATETIME;
