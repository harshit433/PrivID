/**
 * Business Suite repository (folded from the old business-api). Companies + broadcast
 * channels, user subscriptions, messages and per-subscriber deliveries, plus user-side
 * blocks/reports. API-key auth resolves a business by the SHA-256 hash of its key.
 */
import {
  db,
  businesses,
  businessChannels,
  businessSubscriptions,
  businessMessages,
  businessMessageDeliveries,
  businessBlocks,
  businessReports,
  users,
  eq,
  and,
  or,
  lt,
  ne,
  sql,
  desc,
  inArray,
} from '@trustroute/core';

export type BusinessRow = typeof businesses.$inferSelect;
export type ChannelRow = typeof businessChannels.$inferSelect;
export type SubscriptionRow = typeof businessSubscriptions.$inferSelect;
export type MessageRow = typeof businessMessages.$inferSelect;

// ── Businesses ────────────────────────────────────────────────────────────────

export async function createBusiness(input: {
  name: string;
  category: string;
  contactEmail: string;
  gstin?: string | null;
  cin?: string | null;
  website?: string | null;
}): Promise<BusinessRow> {
  const [row] = await db
    .insert(businesses)
    .values({
      name: input.name,
      category: input.category,
      contactEmail: input.contactEmail,
      gstin: input.gstin ?? null,
      cin: input.cin ?? null,
      website: input.website ?? null,
    })
    .returning();
  return row!;
}

export async function findById(businessId: string): Promise<BusinessRow | null> {
  const [row] = await db.select().from(businesses).where(eq(businesses.businessId, businessId)).limit(1);
  return row ?? null;
}

export async function findByApiKeyHash(apiKeyHash: string): Promise<BusinessRow | null> {
  const [row] = await db
    .select()
    .from(businesses)
    .where(and(eq(businesses.apiKeyHash, apiKeyHash), eq(businesses.status, 'verified')))
    .limit(1);
  return row ?? null;
}

export async function setVerified(businessId: string, apiKeyHash: string): Promise<BusinessRow | null> {
  const [row] = await db
    .update(businesses)
    .set({ status: 'verified', apiKeyHash, verifiedAt: sql`now()`, rejectionReason: null, updatedAt: sql`now()` })
    .where(and(eq(businesses.businessId, businessId), ne(businesses.status, 'verified')))
    .returning();
  return row ?? null;
}

export async function setRejected(businessId: string, reason: string): Promise<boolean> {
  const rows = await db
    .update(businesses)
    .set({ status: 'rejected', rejectionReason: reason, updatedAt: sql`now()` })
    .where(eq(businesses.businessId, businessId))
    .returning({ id: businesses.businessId });
  return rows.length > 0;
}

export async function listVerified(limit: number): Promise<BusinessRow[]> {
  return db.select().from(businesses).where(eq(businesses.status, 'verified')).orderBy(desc(businesses.verifiedAt)).limit(limit);
}

export async function listByStatus(status: BusinessRow['status']): Promise<BusinessRow[]> {
  return db.select().from(businesses).where(eq(businesses.status, status)).orderBy(desc(businesses.createdAt)).limit(100);
}

// ── Channels ──────────────────────────────────────────────────────────────────

export async function createChannel(input: {
  businessId: string;
  name: string;
  channelType: ChannelRow['channelType'];
  dailyLimitPerSubscriber?: number;
}): Promise<ChannelRow> {
  const [row] = await db
    .insert(businessChannels)
    .values({ businessId: input.businessId, name: input.name, channelType: input.channelType, dailyLimitPerSubscriber: input.dailyLimitPerSubscriber ?? 10 })
    .returning();
  return row!;
}

export async function listChannels(businessId: string): Promise<ChannelRow[]> {
  return db.select().from(businessChannels).where(eq(businessChannels.businessId, businessId)).orderBy(desc(businessChannels.createdAt));
}

export async function findChannel(channelId: string): Promise<ChannelRow | null> {
  const [row] = await db.select().from(businessChannels).where(eq(businessChannels.channelId, channelId)).limit(1);
  return row ?? null;
}

// ── Subscriptions ─────────────────────────────────────────────────────────────

export async function subscribe(userId: string, businessId: string, channelId: string): Promise<SubscriptionRow> {
  const [row] = await db
    .insert(businessSubscriptions)
    .values({ userId, businessId, channelId, status: 'active', subscribedAt: sql`now()` })
    .onConflictDoUpdate({
      target: [businessSubscriptions.userId, businessSubscriptions.channelId],
      set: { status: 'active', subscribedAt: sql`now()`, cancelledAt: null, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function unsubscribe(userId: string, subscriptionId: string): Promise<boolean> {
  const rows = await db
    .update(businessSubscriptions)
    .set({ status: 'cancelled', cancelledAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(businessSubscriptions.subscriptionId, subscriptionId), eq(businessSubscriptions.userId, userId)))
    .returning({ id: businessSubscriptions.subscriptionId });
  return rows.length > 0;
}

export async function listUserSubscriptions(userId: string): Promise<SubscriptionRow[]> {
  return db
    .select()
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.userId, userId), eq(businessSubscriptions.status, 'active')))
    .orderBy(desc(businessSubscriptions.subscribedAt));
}

/** Active subscribers of a channel who have NOT blocked the business. */
export async function activeSubscribers(channelId: string, businessId: string): Promise<Array<{ subscriptionId: string; userId: string }>> {
  const blocked = db.select({ id: businessBlocks.userId }).from(businessBlocks).where(eq(businessBlocks.businessId, businessId));
  return db
    .select({ subscriptionId: businessSubscriptions.subscriptionId, userId: businessSubscriptions.userId })
    .from(businessSubscriptions)
    .where(
      and(
        eq(businessSubscriptions.channelId, channelId),
        eq(businessSubscriptions.status, 'active'),
        sql`${businessSubscriptions.userId} NOT IN ${blocked}`,
      ),
    );
}

// ── Messages + deliveries ─────────────────────────────────────────────────────

export async function createMessage(input: { channelId: string; businessId: string; content: string; templateId?: string | null; totalSubscribers: number }): Promise<MessageRow> {
  const [row] = await db
    .insert(businessMessages)
    .values({ channelId: input.channelId, businessId: input.businessId, content: input.content, templateId: input.templateId ?? null, totalSubscribers: input.totalSubscribers })
    .returning();
  return row!;
}

export async function recordDeliveries(
  messageId: string,
  subs: Array<{ subscriptionId: string; userId: string }>,
): Promise<void> {
  if (subs.length === 0) return;
  await db
    .insert(businessMessageDeliveries)
    .values(subs.map((s) => ({ messageId, subscriptionId: s.subscriptionId, userId: s.userId, status: 'delivered' as const, deliveredAt: sql`now()` })))
    .onConflictDoNothing({ target: [businessMessageDeliveries.messageId, businessMessageDeliveries.subscriptionId] });
}

export async function finalizeMessage(messageId: string, delivered: number, failed: number): Promise<void> {
  await db
    .update(businessMessages)
    .set({ status: 'sent', sentAt: sql`now()`, totalDelivered: delivered, totalFailed: failed })
    .where(eq(businessMessages.messageId, messageId));
}

export async function listChannelMessages(channelId: string): Promise<MessageRow[]> {
  return db.select().from(businessMessages).where(eq(businessMessages.channelId, channelId)).orderBy(desc(businessMessages.createdAt)).limit(50);
}

export interface InboxItem {
  deliveryId: string;
  messageId: string;
  content: string;
  deliveredAt: Date | null;
  createdAt: Date;
  business: { businessId: string; name: string; logoUrl: string | null };
}

export async function inbox(
  userId: string,
  limit: number,
  cursor: { t: string; id: string } | null,
): Promise<InboxItem[]> {
  const where = cursor
    ? and(
        eq(businessMessageDeliveries.userId, userId),
        or(
          lt(businessMessageDeliveries.createdAt, new Date(cursor.t)),
          and(eq(businessMessageDeliveries.createdAt, new Date(cursor.t)), lt(businessMessageDeliveries.deliveryId, cursor.id)),
        ),
      )
    : eq(businessMessageDeliveries.userId, userId);
  return db
    .select({
      deliveryId: businessMessageDeliveries.deliveryId,
      messageId: businessMessages.messageId,
      content: businessMessages.content,
      deliveredAt: businessMessageDeliveries.deliveredAt,
      createdAt: businessMessageDeliveries.createdAt,
      business: { businessId: businesses.businessId, name: businesses.name, logoUrl: businesses.logoUrl },
    })
    .from(businessMessageDeliveries)
    .innerJoin(businessMessages, eq(businessMessages.messageId, businessMessageDeliveries.messageId))
    .innerJoin(businesses, eq(businesses.businessId, businessMessages.businessId))
    .where(where)
    .orderBy(desc(businessMessageDeliveries.createdAt), desc(businessMessageDeliveries.deliveryId))
    .limit(limit + 1);
}

// ── Blocks + reports ──────────────────────────────────────────────────────────

export async function block(userId: string, businessId: string, reason?: string | null): Promise<void> {
  await db
    .insert(businessBlocks)
    .values({ userId, businessId, reason: reason ?? null })
    .onConflictDoNothing({ target: [businessBlocks.userId, businessBlocks.businessId] });
}

export async function unblock(userId: string, businessId: string): Promise<boolean> {
  const rows = await db
    .delete(businessBlocks)
    .where(and(eq(businessBlocks.userId, userId), eq(businessBlocks.businessId, businessId)))
    .returning({ id: businessBlocks.blockId });
  return rows.length > 0;
}

export async function blockedBusinessIds(userId: string): Promise<string[]> {
  const rows = await db.select({ id: businessBlocks.businessId }).from(businessBlocks).where(eq(businessBlocks.userId, userId));
  return rows.map((r) => r.id);
}

export async function report(userId: string, businessId: string, reason?: string | null): Promise<void> {
  await db.insert(businessReports).values({ userId, businessId, reason: reason ?? null });
}

export async function findSubscription(
  userId: string,
  channelId: string,
): Promise<SubscriptionRow | null> {
  const [row] = await db
    .select()
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.userId, userId), eq(businessSubscriptions.channelId, channelId)))
    .limit(1);
  return row ?? null;
}

export async function isBlocked(userId: string, businessId: string): Promise<boolean> {
  const [row] = await db
    .select({ id: businessBlocks.blockId })
    .from(businessBlocks)
    .where(and(eq(businessBlocks.userId, userId), eq(businessBlocks.businessId, businessId)))
    .limit(1);
  return !!row;
}

/** Active-subscription channel ids for a user (to annotate the directory). */
export async function subscribedChannelIds(userId: string): Promise<string[]> {
  const rows = await db
    .select({ id: businessSubscriptions.channelId })
    .from(businessSubscriptions)
    .where(and(eq(businessSubscriptions.userId, userId), eq(businessSubscriptions.status, 'active')));
  return rows.map((r) => r.id);
}

/** Handles for a set of user ids (used when composing push payloads). */
export async function displayNames(userIds: string[]): Promise<Map<string, string>> {
  if (userIds.length === 0) return new Map();
  const rows = await db.select({ userId: users.userId, handle: users.handle }).from(users).where(inArray(users.userId, userIds));
  return new Map(rows.map((r) => [r.userId, r.handle]));
}
