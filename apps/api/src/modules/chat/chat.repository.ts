/**
 * Chat repository. Chat itself lives in Stream; we keep only the server-authoritative
 * registry: the deterministic 1:1 channel record (sorted member pair → stable cid) and
 * an append-only message log that backs auditing + abuse signals.
 */
import { db, chatChannels, chatMessageLog, users, eq, and, or, sql, desc } from '@trustroute/core';

export type ChannelRow = typeof chatChannels.$inferSelect;

/** Deterministic channel id for a member pair: order-independent. */
export function pairCid(a: string, b: string): { cid: string; low: string; high: string } {
  const [low, high] = a < b ? [a, b] : [b, a];
  return { cid: `messaging:${low}__${high}`, low, high };
}

export async function ensureChannel(a: string, b: string): Promise<ChannelRow> {
  const { cid, low, high } = pairCid(a, b);
  const [row] = await db
    .insert(chatChannels)
    .values({ channelCid: cid, memberLow: low, memberHigh: high })
    .onConflictDoNothing({ target: chatChannels.channelCid })
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(chatChannels).where(eq(chatChannels.channelCid, cid)).limit(1);
  return existing!;
}

export interface ChannelWithCounterpart {
  channelCid: string;
  createdAt: Date;
  counterpart: {
    userId: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    trustTier: (typeof users.$inferSelect)['trustTier'];
  };
}

export async function listChannels(userId: string): Promise<ChannelWithCounterpart[]> {
  return db
    .select({
      channelCid: chatChannels.channelCid,
      createdAt: chatChannels.createdAt,
      counterpart: {
        userId: users.userId,
        handle: users.handle,
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        trustTier: users.trustTier,
      },
    })
    .from(chatChannels)
    .innerJoin(
      users,
      sql`${users.userId} = CASE WHEN ${chatChannels.memberLow} = ${userId} THEN ${chatChannels.memberHigh} ELSE ${chatChannels.memberLow} END`,
    )
    .where(or(eq(chatChannels.memberLow, userId), eq(chatChannels.memberHigh, userId)))
    .orderBy(desc(chatChannels.updatedAt));
}

export async function touchChannel(cid: string): Promise<void> {
  await db.update(chatChannels).set({ updatedAt: sql`now()` }).where(eq(chatChannels.channelCid, cid));
}

export async function logMessage(input: {
  messageId: string;
  channelCid: string;
  senderId: string;
  recipientId: string;
}): Promise<void> {
  await db
    .insert(chatMessageLog)
    .values(input)
    .onConflictDoNothing({ target: chatMessageLog.messageId });
}
