/**
 * BullMQ requires maxRetriesPerRequest: null — it blocks indefinitely waiting for jobs.
 * We can't use the shared getRedis() (which has maxRetriesPerRequest: 3),
 * so we create a dedicated connection here.
 */
import Redis from 'ioredis';

export function getBullRedis(): Redis {
  return new Redis(process.env.REDIS_URL ?? 'redis://localhost:6379', {
    maxRetriesPerRequest: null,   // required by BullMQ
    enableReadyCheck: false,
  });
}
