import { Queue } from 'bullmq';
import Redis from 'ioredis';
import { resolveRedisUrl } from '@trustroute/shared';
import { logger } from '../utils/logger';

let queue: Queue | null = null;
let bullRedis: Redis | null = null;

function getBullRedis(): Redis {
  if (!bullRedis) {
    bullRedis = new Redis(resolveRedisUrl(), {
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return bullRedis;
}

function getDataExportQueue(): Queue {
  if (!queue) {
    queue = new Queue('data-export', { connection: getBullRedis() });
  }
  return queue;
}

export function scheduleDataExport(requestId: string, userId: string): void {
  getDataExportQueue()
    .add(
      'export',
      { request_id: requestId, user_id: userId },
      {
        jobId: `data-export:${requestId}`,
        removeOnComplete: { count: 100 },
        removeOnFail: { count: 50 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 5_000 },
      },
    )
    .catch((err: Error) => {
      logger.warn('data-export-queue', 'Failed to enqueue data export', {
        requestId,
        userId,
        error: err.message,
      });
    });
}
