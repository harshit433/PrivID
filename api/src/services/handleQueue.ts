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

function getHandlePropagationQueue(): Queue {
  if (!queue) {
    queue = new Queue('handle-propagation', { connection: getBullRedis() });
  }
  return queue;
}

export function scheduleHandlePropagation(jobId: string, userId: string): void {
  getHandlePropagationQueue()
    .add(
      'propagate',
      { job_id: jobId, user_id: userId },
      {
        jobId: `handle-propagation:${jobId}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 50 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    )
    .catch((err: Error) => {
      logger.warn('handle-queue', 'Failed to enqueue handle propagation', {
        jobId,
        userId,
        error: err.message,
      });
    });
}
