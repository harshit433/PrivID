/**
 * Business-message delivery for SCHEDULED broadcasts. Immediate broadcasts are fanned
 * out synchronously by the API; this job handles messages queued with a future
 * `scheduled_at`. The scheduler's scan enqueues one job per message whose time has come.
 *
 * Per message: claim it (queued→sending), resolve active subscribers who haven't blocked
 * the business and are under the channel's per-day cap, record deliveries, push to each
 * subscriber's devices (honouring the company_updates preference), then finalize totals.
 */
import {
  db,
  businessMessages,
  businessMessageDeliveries,
  deviceRegistrations,
  users,
  sql,
  eq,
  and,
  getPushProvider,
  enqueue,
  logger,
  type JobMap,
} from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

interface Subscriber { subscriptionId: string; userId: string; businessName: string }

async function pushToUser(userId: string, title: string, body: string, data: Record<string, string>): Promise<boolean> {
  const [pref] = await db
    .select({ blocked: sql<boolean>`(${users.notificationPrefs} ->> 'company_updates') = 'false'` })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  if (pref?.blocked) return false;
  const devices = await db
    .select({ token: deviceRegistrations.pushToken })
    .from(deviceRegistrations)
    .where(and(eq(deviceRegistrations.userId, userId), sql`${deviceRegistrations.pushToken} IS NOT NULL`));
  const push = getPushProvider();
  let ok = false;
  for (const d of devices) {
    try {
      await push.sendNotification(d.token!, { title, body }, data, 'company_updates');
      ok = true;
    } catch (err) {
      logger.warn('worker:business-message-deliver', 'push failed', { userId, error: (err as Error).message });
    }
  }
  return ok || devices.length === 0; // no device ≠ delivery failure (in-app inbox still has it)
}

async function deliver(messageId: string): Promise<void> {
  const [msg] = await db
    .update(businessMessages)
    .set({ status: 'sending' })
    .where(sql`${businessMessages.messageId} = ${messageId} AND ${businessMessages.status} = 'queued' AND (${businessMessages.scheduledAt} IS NULL OR ${businessMessages.scheduledAt} <= now())`)
    .returning();
  if (!msg) return; // not due, already sent, or gone

  const subsRes = await db.execute(sql`
    SELECT s.subscription_id AS "subscriptionId", s.user_id AS "userId", b.name AS "businessName"
    FROM business_subscriptions s
    JOIN businesses b ON b.business_id = s.business_id
    JOIN users u ON u.user_id = s.user_id
    JOIN business_channels c ON c.channel_id = s.channel_id
    WHERE s.channel_id = ${msg.channelId} AND s.status = 'active' AND u.is_active = TRUE
      AND NOT EXISTS (SELECT 1 FROM business_blocks bl WHERE bl.user_id = s.user_id AND bl.business_id = s.business_id)
      AND (
        SELECT COUNT(*) FROM business_message_deliveries d
        JOIN business_messages m2 ON m2.message_id = d.message_id
        WHERE d.subscription_id = s.subscription_id AND m2.channel_id = s.channel_id
          AND d.status = 'delivered' AND d.delivered_at >= CURRENT_DATE
      ) < c.daily_limit_per_subscriber
  `);
  const subs = subsRes.rows as unknown as Subscriber[];

  if (subs.length === 0) {
    await db.update(businessMessages).set({ status: 'sent', sentAt: sql`now()`, totalSubscribers: 0, totalDelivered: 0, totalFailed: 0 }).where(eq(businessMessages.messageId, messageId));
    return;
  }

  await db
    .insert(businessMessageDeliveries)
    .values(subs.map((s) => ({ messageId, subscriptionId: s.subscriptionId, userId: s.userId, status: 'pending' as const })))
    .onConflictDoNothing();

  let delivered = 0;
  let failed = 0;
  const data = { type: 'business_message', businessId: msg.businessId, messageId };
  for (const s of subs) {
    const ok = await pushToUser(s.userId, s.businessName, msg.content.slice(0, 140), data);
    await db
      .update(businessMessageDeliveries)
      .set(ok ? { status: 'delivered', deliveredAt: sql`now()` } : { status: 'failed', errorMessage: 'push_failed' })
      .where(and(eq(businessMessageDeliveries.messageId, messageId), eq(businessMessageDeliveries.subscriptionId, s.subscriptionId)));
    if (ok) delivered++;
    else failed++;
  }

  await db
    .update(businessMessages)
    .set({ status: delivered > 0 || failed === 0 ? 'sent' : 'failed', sentAt: sql`now()`, totalSubscribers: subs.length, totalDelivered: delivered, totalFailed: failed })
    .where(eq(businessMessages.messageId, messageId));
  logger.info('worker:business-message-deliver', 'delivered', { messageId, delivered, failed });
}

const process: Processor<JobMap['business-message-deliver']> = async (job) => {
  if (job.data.message_id) await deliver(job.data.message_id);
};

/** Scheduler scan: enqueue delivery for queued messages whose scheduled_at has passed. */
export async function enqueueDueBusinessMessages(): Promise<void> {
  const due = await db
    .select({ messageId: businessMessages.messageId })
    .from(businessMessages)
    .where(sql`${businessMessages.status} = 'queued' AND ${businessMessages.scheduledAt} IS NOT NULL AND ${businessMessages.scheduledAt} <= now()`)
    .limit(50);
  for (const { messageId } of due) {
    await enqueue('business-message-deliver', { message_id: messageId }, { jobId: `biz-msg-${messageId}` });
  }
  if (due.length) logger.info('worker:business-message-deliver', 'enqueued due messages', { count: due.length });
}

export const businessMessageDeliver: JobDescriptor<'business-message-deliver'> = { name: 'business-message-deliver', process, concurrency: 2 };
