/**
 * Enqueue trust score recomputation on the worker (BullMQ).
 * Dedupes per user so rapid factor updates collapse into one job.
 */

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

function getTrustRecomputeQueue(): Queue {
  if (!queue) {
    queue = new Queue('trust-recompute', { connection: getBullRedis() });
  }
  return queue;
}

export function scheduleTrustRecompute(userId: string, reason: string): void {
  getTrustRecomputeQueue()
    .add(
      reason,
      { user_id: userId, reason },
      {
        jobId: `trust-recompute:${userId}`,
        removeOnComplete: { count: 200 },
        removeOnFail: { count: 50 },
        attempts: 3,
        backoff: { type: 'exponential', delay: 2_000 },
      },
    )
    .catch((err: Error) => {
      logger.warn('trust-queue', 'Failed to enqueue trust recompute', {
        userId,
        reason,
        error: err.message,
      });
    });
}
