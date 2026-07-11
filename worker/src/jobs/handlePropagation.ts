import { Worker, Job } from 'bullmq';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';

export interface HandlePropagationJob {
  job_id: string;
  user_id: string;
}

export function startHandlePropagationWorker() {
  const worker = new Worker<HandlePropagationJob>(
    'handle-propagation',
    async (job: Job<HandlePropagationJob>) => {
      const { runHandlePropagation, scanPendingHandlePropagations } = await import(
        '../../api/src/services/handleChange'
      );
      if (job.data.job_id) {
        await runHandlePropagation(job.data.job_id);
      } else {
        await scanPendingHandlePropagations();
      }
    },
    { connection: getBullRedis(), concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    logger.error('handle-propagation', `Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}

export async function enqueueHandlePropagationScan(): Promise<void> {
  const { handlePropagationQueue } = await import('../queues');
  await handlePropagationQueue.add(
    'scan',
    { job_id: '', user_id: '' },
    { jobId: `handle-prop-scan-${Math.floor(Date.now() / 300_000)}`, removeOnComplete: 50 },
  );
}
