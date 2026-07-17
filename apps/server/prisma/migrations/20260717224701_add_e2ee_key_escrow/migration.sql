-- Hybrid E2EE key escrow: password-wrapped secret key stored server-side.
ALTER TABLE "User" ADD COLUMN "e2eeWrappedKey" TEXT;
ALTER TABLE "User" ADD COLUMN "e2eeKeySalt" TEXT;
ALTER TABLE "User" ADD COLUMN "e2eeKeyNonce" TEXT;
