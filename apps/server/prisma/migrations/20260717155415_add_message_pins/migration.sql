-- AlterTable
ALTER TABLE "Message" ADD COLUMN "pinnedAt" DATETIME;
ALTER TABLE "Message" ADD COLUMN "pinnedById" TEXT;

-- CreateIndex
CREATE INDEX "Message_threadType_threadId_pinnedAt_idx" ON "Message"("threadType", "threadId", "pinnedAt");
