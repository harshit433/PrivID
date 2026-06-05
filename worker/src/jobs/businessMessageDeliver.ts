import { Worker, Job } from 'bullmq';
import { query, queryOne, sendBusinessMessageMulticast } from '@trustroute/shared';
import type { BusinessMessageDeliverJob } from '../queues';
import { getBullRedis } from '../redis';

const BATCH_SIZE = 500;

export function startBusinessMessageDeliverWorker() {
  const worker = new Worker<BusinessMessageDeliverJob>(
    'business-message-deliver',
    async (job: Job<BusinessMessageDeliverJob>) => {
      if (!job.data.message_id) return;
      await deliverMessage(job.data.message_id);
    },
    { connection: getBullRedis(), concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[business-message-deliver] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function deliverMessage(messageId: string) {
  const msg = await queryOne<{
    message_id: string;
    channel_id: string;
    business_id: string;
    content: string;
    status: string;
    business_name: string;
    daily_limit_per_subscriber: number;
  }>(
    `SELECT m.message_id, m.channel_id, m.business_id, m.content, m.status::text AS status,
            b.name AS business_name, c.daily_limit_per_subscriber
     FROM business_messages m
     JOIN businesses b ON b.business_id = m.business_id
     JOIN business_channels c ON c.channel_id = m.channel_id
     WHERE m.message_id = $1`,
    [messageId],
  );

  if (!msg) {
    console.warn(`[business-message-deliver] Message ${messageId} not found`);
    return;
  }

  if (msg.status !== 'queued') return;

  const scheduled = await queryOne<{ ready: boolean }>(
    `SELECT (scheduled_at IS NULL OR scheduled_at <= NOW()) AS ready
     FROM business_messages WHERE message_id = $1`,
    [messageId],
  );
  if (!scheduled?.ready) return;

  await query(
    `UPDATE business_messages SET status = 'sending' WHERE message_id = $1 AND status = 'queued'`,
    [messageId],
  );

  const subscribers = await query<{
    subscription_id: string;
    user_id: string;
    fcm_token: string | null;
  }>(
    `SELECT s.subscription_id, s.user_id, u.fcm_token
     FROM business_subscriptions s
     JOIN users u ON u.user_id = s.user_id
     WHERE s.channel_id = $1 AND s.status = 'active' AND u.is_active = TRUE
       AND (
         SELECT COUNT(*)::int
         FROM business_message_deliveries d
         JOIN business_messages m2 ON m2.message_id = d.message_id
         WHERE d.subscription_id = s.subscription_id
           AND m2.channel_id = $1
           AND d.status = 'delivered'
           AND d.delivered_at >= CURRENT_DATE
       ) < $2`,
    [msg.channel_id, msg.daily_limit_per_subscriber],
  );

  if (subscribers.length === 0) {
    await query(
      `UPDATE business_messages
       SET status = 'sent', sent_at = NOW(), total_delivered = 0, total_failed = 0
       WHERE message_id = $1`,
      [messageId],
    );
    return;
  }

  await query(
    `INSERT INTO business_message_deliveries (message_id, subscription_id, user_id, status)
     SELECT $1, s.subscription_id, s.user_id, 'pending'
     FROM business_subscriptions s
     WHERE s.channel_id = $2 AND s.status = 'active'
       AND s.subscription_id = ANY($3::uuid[])
     ON CONFLICT (message_id, subscription_id) DO NOTHING`,
    [messageId, msg.channel_id, subscribers.map((s) => s.subscription_id)],
  );

  let totalDelivered = 0;
  let totalFailed = 0;

  const payload = {
    message_id: messageId,
    business_id: msg.business_id,
    business_name: msg.business_name,
    channel_id: msg.channel_id,
    content: msg.content,
    is_verified: true,
  };

  const withToken = subscribers.filter((s) => s.fcm_token);
  const noToken = subscribers.filter((s) => !s.fcm_token);

  for (let i = 0; i < withToken.length; i += BATCH_SIZE) {
    const chunk = withToken.slice(i, i + BATCH_SIZE);
    const tokens = chunk.map((s) => s.fcm_token!);
    const { successes } = await sendBusinessMessageMulticast(tokens, payload);

    const successIds: string[] = [];
    const failIds: string[] = [];
    chunk.forEach((sub, idx) => {
      if (successes[idx]) {
        successIds.push(sub.subscription_id);
        totalDelivered += 1;
      } else {
        failIds.push(sub.subscription_id);
        totalFailed += 1;
      }
    });

    if (successIds.length > 0) {
      await query(
        `UPDATE business_message_deliveries
         SET status = 'delivered', delivered_at = NOW()
         WHERE message_id = $1 AND subscription_id = ANY($2::uuid[])`,
        [messageId, successIds],
      );
    }
    if (failIds.length > 0) {
      await query(
        `UPDATE business_message_deliveries
         SET status = 'failed', error_message = 'fcm_send_failed'
         WHERE message_id = $1 AND subscription_id = ANY($2::uuid[])`,
        [messageId, failIds],
      );
    }
  }

  if (noToken.length > 0) {
    await query(
      `UPDATE business_message_deliveries
       SET status = 'failed', error_message = 'no_fcm_token'
       WHERE message_id = $1 AND subscription_id = ANY($2::uuid[])`,
      [messageId, noToken.map((s) => s.subscription_id)],
    );
    totalFailed += noToken.length;
  }

  const finalStatus = totalDelivered > 0 ? 'sent' : totalFailed > 0 ? 'failed' : 'sent';
  await query(
    `UPDATE business_messages
     SET status = $5::business_message_status, sent_at = NOW(),
         total_delivered = $2, total_failed = $3, total_subscribers = $4
     WHERE message_id = $1`,
    [messageId, totalDelivered, totalFailed, subscribers.length, finalStatus],
  );

  console.log(
    `[business-message-deliver] ${messageId}: delivered=${totalDelivered} failed=${totalFailed}`,
  );
}

export async function enqueueBusinessMessageDelivery(messageId: string) {
  const { businessMessageDeliverQueue } = await import('../queues');
  await businessMessageDeliverQueue.add(
    'deliver',
    { message_id: messageId },
    {
      jobId: `biz-msg-${messageId}`,
      removeOnComplete: true,
      removeOnFail: 100,
    },
  );
}

/** Enqueue delivery for queued messages whose scheduled_at has passed. */
export async function enqueueDueScheduledBusinessMessages() {
  const due = await query<{ message_id: string }>(
    `SELECT message_id FROM business_messages
     WHERE status = 'queued' AND scheduled_at IS NOT NULL AND scheduled_at <= NOW()
     ORDER BY scheduled_at ASC
     LIMIT 50`,
  );

  for (const row of due) {
    await enqueueBusinessMessageDelivery(row.message_id);
  }
}
