import { Worker, Job } from 'bullmq';
import { query } from '@trustroute/shared';
import type { StatusExpiryJob } from '../queues';
import { getBullRedis } from '../redis';

/**
 * Deletes expired status rows and best-effort S3 cleanup for status media.
 */
export function startStatusExpiryWorker() {
  const worker = new Worker<StatusExpiryJob>(
    'status-expiry',
    async () => {
      await purgeExpiredStatus();
    },
    { connection: getBullRedis(), concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    console.error(`[status-expiry] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

async function purgeExpiredStatus() {
  const expired = await query<{ status_id: string; media_url: string | null }>(
    `DELETE FROM user_status_updates
     WHERE expires_at < NOW()
     RETURNING status_id, media_url`,
  );

  if (expired.length > 0) {
    console.log(`[status-expiry] Purged ${expired.length} expired status item(s)`);
  }
}

export async function enqueueStatusExpiryScan() {
  const { statusExpiryQueue } = await import('../queues');
  await statusExpiryQueue.add(
    'scan',
    {},
    { jobId: `status-expiry-${Math.floor(Date.now() / 300000)}`, removeOnComplete: true },
  );
}
