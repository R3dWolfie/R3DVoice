import { prisma } from "../db.js";

export interface UnreadCounts {
  counts: Record<string, number>;
  totalUnread: number;
}

/**
 * Compute unread counts for a user across all DM threads they're part of.
 *
 * Logic:
 *   - For each DM thread the user participates in, find lastReadAt (or
 *     epoch if no marker exists).
 *   - Count messages in that thread, NOT authored by the user, with
 *     createdAt > lastReadAt.
 *
 * Mute integration:
 *   - level=none → 0 contribution.
 *   - level=mentions → only messages mentioning the user count.
 *   - level=all (default) → all unread messages count.
 */
export async function computeUnread(userId: string): Promise<UnreadCounts> {
  const counts: Record<string, number> = {};
  let total = 0;

  const dmRows = await prisma.message.findMany({
    where: {
      threadType: "dm",
      OR: [{ threadId: { startsWith: `${userId}:` } }, { threadId: { endsWith: `:${userId}` } }],
    },
    select: { threadId: true },
    distinct: ["threadId"],
  });
  const dmThreadIds = dmRows.map((r) => r.threadId);

  const reads = await prisma.threadReadState.findMany({
    where: { userId, threadType: "dm", threadId: { in: dmThreadIds } },
  });
  const readByThread = new Map(reads.map((r) => [r.threadId, r.lastReadAt]));

  const mutes = await prisma.threadMuteState.findMany({
    where: { userId, threadType: "dm", threadId: { in: dmThreadIds } },
  });
  const muteByThread = new Map(mutes.map((m) => [m.threadId, m]));

  // Single query for every candidate message across all threads (was one query
  // per thread → K+3). Read-state / mute filtering happens in memory below.
  const messages = await prisma.message.findMany({
    where: {
      threadType: "dm",
      threadId: { in: dmThreadIds },
      authorId: { not: userId },
    },
    select: { threadId: true, createdAt: true, mentions: true },
  });
  const byThread = new Map<string, Array<{ createdAt: Date; mentions: string | null }>>();
  for (const m of messages) {
    const arr = byThread.get(m.threadId);
    if (arr) arr.push(m);
    else byThread.set(m.threadId, [m]);
  }

  for (const threadId of dmThreadIds) {
    const mute = muteByThread.get(threadId);
    if (mute?.level === "none") continue;

    const lastRead = readByThread.get(threadId) ?? new Date(0);
    const unread = (byThread.get(threadId) ?? []).filter((m) => m.createdAt > lastRead);

    let n = unread.length;
    if (mute?.level === "mentions") {
      n = unread.filter((m) => {
        if (!m.mentions) return false;
        try {
          const arr = JSON.parse(m.mentions) as string[];
          return arr.includes(userId);
        } catch {
          return false;
        }
      }).length;
    }
    if (n > 0) {
      counts[`dm:${threadId}`] = n;
      total += n;
    }
  }

  return { counts, totalUnread: total };
}
