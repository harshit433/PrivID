/**
 * Chat repository. Chat itself lives in Stream; we keep only the server-authoritative
 * registry: the deterministic 1:1 channel record (sorted member pair → stable cid) and
 * an append-only message log that backs auditing + abuse signals.
 */
import crypto from 'node:crypto';
import { db, chatChannels, chatMessageLog, users, eq, and, or, sql, desc } from '@trustroute/core';

export type ChannelRow = typeof chatChannels.$inferSelect;

/**
 * Deterministic channel id for a member pair: order-independent.
 *
 * The id is a hash of the sorted pair, not the pair itself. Stream caps a
 * channel id at 64 characters and `<uuid>__<uuid>` is 74, so the literal form
 * made every 1:1 `getOrCreateChannel` fail with a 400. The hash is stable for
 * a given pair, so the cid stays derivable without a lookup — but it is no
 * longer reversible, so members come from the `chat_channels` row (see
 * `findByCid`) rather than from splitting the string.
 */
export function pairCid(a: string, b: string): { cid: string; low: string; high: string } {
  const [low, high] = a < b ? [a, b] : [b, a];
  const digest = crypto.createHash('sha256').update(`${low}__${high}`).digest('hex').slice(0, 40);
  return { cid: `messaging:dm-${digest}`, low, high };
}

export async function ensureChannel(a: string, b: string): Promise<ChannelRow> {
  const { cid, low, high } = pairCid(a, b);
  const [row] = await db
    .insert(chatChannels)
    .values({ channelCid: cid, memberLow: low, memberHigh: high })
    // The pair is uniquely indexed too, so a row written under the old
    // long-form cid must not resurface as a duplicate-pair insert failure.
    .onConflictDoNothing()
    .returning();
  if (row) return row;
  const [existing] = await db
    .select()
    .from(chatChannels)
    .where(and(eq(chatChannels.memberLow, low), eq(chatChannels.memberHigh, high)))
    .limit(1);
  if (existing && existing.channelCid !== cid) {
    // Migrate a pre-hash row onto the new cid in place, preserving its history.
    const [moved] = await db
      .update(chatChannels)
      .set({ channelCid: cid, updatedAt: sql`now()` })
      .where(and(eq(chatChannels.memberLow, low), eq(chatChannels.memberHigh, high)))
      .returning();
    if (moved) return moved;
  }
  return existing!;
}

/** Look up a 1:1 channel by cid. Members are no longer encoded in the id. */
export async function findByCid(cid: string): Promise<ChannelRow | null> {
  const [row] = await db.select().from(chatChannels).where(eq(chatChannels.channelCid, cid)).limit(1);
  return row ?? null;
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
