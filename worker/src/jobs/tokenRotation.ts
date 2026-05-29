import { Worker, Job } from 'bullmq';
import { query } from '@privid/shared';
import type { TokenRotationJob } from '../queues';
import { getBullRedis } from '../redis';

/**
 * Token Rotation / Cleanup Worker
 *
 * Purges expired + revoked refresh tokens older than 7 days.
 * Runs daily via cron in index.ts.
 */
export function startTokenRotationWorker() {
  const worker = new Worker<TokenRotationJob>(
    'token-rotation',
    async (_job: Job<TokenRotationJob>) => {
      const result = await query<{ token_id: string }>(
        `DELETE FROM refresh_tokens
         WHERE (expires_at < NOW() OR revoked = TRUE)
           AND created_at < NOW() - INTERVAL '7 days'
         RETURNING token_id`
      );

      console.log(`[token-rotation] Purged ${result.length} stale refresh tokens`);

      // Also clean up expired OTP sessions older than 1 hour
      const otpResult = await query(
        `DELETE FROM otp_sessions WHERE expires_at < NOW() - INTERVAL '1 hour' RETURNING session_id`
      );
      console.log(`[token-rotation] Purged ${otpResult.length} expired OTP sessions`);
    },
    { connection: getBullRedis(), concurrency: 1 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[token-rotation] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

export async function enqueueTokenRotation() {
  const { tokenRotationQueue } = await import('../queues');
  await tokenRotationQueue.add(
    'cleanup',
    {},
    { jobId: `token-cleanup-${new Date().toISOString().slice(0, 10)}`, removeOnComplete: true }
  );
}
