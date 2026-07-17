-- AlterTable
ALTER TABLE "Room" ADD COLUMN "description" TEXT;

-- RedefineTables
PRAGMA defer_foreign_keys=ON;
PRAGMA foreign_keys=OFF;
CREATE TABLE "new_User" (
    "id" TEXT NOT NULL PRIMARY KEY,
    "email" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "passwordHash" TEXT NOT NULL,
    "createdAt" DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "totpSecret" TEXT,
    "totpEnabledAt" DATETIME,
    "e2eePublicKey" TEXT,
    "handle" TEXT,
    "handleLower" TEXT,
    "dndUntil" DATETIME,
    "avatarUrl" TEXT,
    "currentRoomId" TEXT,
    CONSTRAINT "User_currentRoomId_fkey" FOREIGN KEY ("currentRoomId") REFERENCES "Room" ("id") ON DELETE SET NULL ON UPDATE CASCADE
);
INSERT INTO "new_User" ("avatarUrl", "createdAt", "currentRoomId", "displayName", "dndUntil", "e2eePublicKey", "email", "handle", "handleLower", "id", "passwordHash", "totpEnabledAt", "totpSecret") SELECT "avatarUrl", "createdAt", "currentRoomId", "displayName", "dndUntil", "e2eePublicKey", "email", "handle", "handleLower", "id", "passwordHash", "totpEnabledAt", "totpSecret" FROM "User";
DROP TABLE "User";
ALTER TABLE "new_User" RENAME TO "User";
CREATE UNIQUE INDEX "User_email_key" ON "User"("email");
CREATE UNIQUE INDEX "User_handleLower_key" ON "User"("handleLower");
PRAGMA foreign_keys=ON;
PRAGMA defer_foreign_keys=OFF;
