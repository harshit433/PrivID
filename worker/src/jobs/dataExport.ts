import { Worker, Job } from 'bullmq';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';

export interface DataExportJob {
  request_id: string;
  user_id: string;
}

export function startDataExportWorker() {
  const worker = new Worker<DataExportJob>(
    'data-export',
    async (job: Job<DataExportJob>) => {
      const { runDataExport } = await import('../../api/src/services/dataExport');
      await runDataExport(job.data.request_id);
      logger.info('data-export', 'Export complete', { request_id: job.data.request_id });
    },
    { connection: getBullRedis(), concurrency: 2 },
  );

  worker.on('failed', (job, err) => {
    logger.error('data-export', `Job ${job?.id} failed: ${err.message}`);
  });

  return worker;
}
