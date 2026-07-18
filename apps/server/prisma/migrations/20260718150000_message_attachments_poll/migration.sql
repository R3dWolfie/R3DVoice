-- Message attachments (#30) and polls (#29). Both additive nullable JSON-in-TEXT.
ALTER TABLE "Message" ADD COLUMN "attachments" TEXT;
ALTER TABLE "Message" ADD COLUMN "poll" TEXT;
