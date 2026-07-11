import { Worker, Job } from 'bullmq';
import type { ReferralQualificationJob } from '../queues';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';

/**
 * Daily referral qualification scan — evaluates invited → paid state machine.
 */
export function startReferralQualificationWorker() {
  const worker = new Worker<ReferralQualificationJob>(
    'referral-qualification',
    async (_job: Job<ReferralQualificationJob>) => {
      const { runReferralQualificationScan } = await import(
        '../../api/src/services/referralQualification'
      );
      const result = await runReferralQualificationScan();
      logger.info('referral-qualification', 'Scan complete', result);
    },
    { connection: getBullRedis(), concurrency: 1 },
  );

  worker.on('failed', (job, err) => {
    logger.error('referral-qualification', `Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

export async function enqueueReferralQualificationScan(): Promise<void> {
  const { referralQualificationQueue } = await import('../queues');
  await referralQualificationQueue.add(
    'scan',
    {},
    { jobId: `referral-qual-${Math.floor(Date.now() / 3_600_000)}`, removeOnComplete: 100 },
  );
}
