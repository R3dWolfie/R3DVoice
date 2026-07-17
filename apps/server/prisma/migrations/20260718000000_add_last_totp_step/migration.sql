-- Track the last consumed TOTP 30s step so a still-valid code can't be replayed
-- within its ~90s window (one-time semantics, like backup codes).
ALTER TABLE "User" ADD COLUMN "lastTotpStep" INTEGER;
