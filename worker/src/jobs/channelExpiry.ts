import { Worker, Job } from 'bullmq';
import { query } from '@trustroute/shared';
import type { ChannelExpiryJob } from '../queues';
import { getBullRedis } from '../redis';

/**
 * Channel Expiry Worker
 *
 * Marks reachability channels as 'expired' when:
 *   - expires_at < NOW()
 *   - total_limit is set AND use_count >= total_limit
 *
 * Runs every 5 minutes via cron in index.ts
 */
export function startChannelExpiryWorker() {
  const worker = new Worker<ChannelExpiryJob>(
    'channel-expiry',
    async (job: Job<ChannelExpiryJob>) => {
      const { channel_id } = job.data;

      if (channel_id) {
        // Single channel check
        await expireChannel(channel_id);
      } else {
        // Bulk scan
        await expireAllStale();
      }
    },
    { connection: getBullRedis(), concurrency: 2 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[channel-expiry] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function expireChannel(channelId: string) {
  await query(
    `UPDATE reachability_channels
     SET status = 'expired'
     WHERE channel_id = $1
       AND status = 'active'
       AND (
         (expires_at IS NOT NULL AND expires_at < NOW())
         OR (total_limit IS NOT NULL AND use_count >= total_limit)
       )`,
    [channelId]
  );
}

async function expireAllStale() {
  const result = await query<{ channel_id: string }>(
    `UPDATE reachability_channels
     SET status = 'expired'
     WHERE status = 'active'
       AND (
         (expires_at IS NOT NULL AND expires_at < NOW())
         OR (total_limit IS NOT NULL AND use_count >= total_limit)
       )
     RETURNING channel_id`
  );

  if (result.length > 0) {
    console.log(`[channel-expiry] Expired ${result.length} channels:`, result.map((r) => r.channel_id));
  }
}

export async function enqueueChannelExpiryScan() {
  const { channelExpiryQueue } = await import('../queues');
  await channelExpiryQueue.add(
    'scan',
    {},
    { jobId: `expiry-scan-${Math.floor(Date.now() / 300000)}`, removeOnComplete: true }
  );
}
