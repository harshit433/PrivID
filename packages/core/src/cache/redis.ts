/**
 * Single shared ioredis client. Railway starts the API before Redis is ready, so
 * `connectRedis()` blocks with backoff at startup; individual callers use `getRedis()`.
 */
import Redis from 'ioredis';
import { loadConfig } from '../config';
import { logger } from '../logger';

let client: Redis | null = null;

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function resolveRedisUrl(): string {
  const cfg = loadConfig();
  return cfg.REDIS_PRIVATE_URL ?? cfg.REDIS_URL ?? 'redis://localhost:6379';
}

export function getRedis(): Redis {
  if (!client) {
    client = new Redis(resolveRedisUrl(), {
      maxRetriesPerRequest: 3,
      lazyConnect: true,
      connectTimeout: 10_000,
      retryStrategy: (times) => (times > 30 ? null : Math.min(times * 200, 3_000)),
      reconnectOnError: (err) => {
        const msg = err.message ?? '';
        return (
          msg.includes('READONLY') ||
          msg.includes('ECONNREFUSED') ||
          msg.includes('ETIMEDOUT') ||
          msg.includes('EHOSTUNREACH')
        );
      },
    });
    client.on('error', (err) => logger.warn('redis', 'connection error', { error: err.message }));
  }
  return client;
}

/** Block until Redis accepts connections. Safe to call once at startup. */
export async function connectRedis(maxAttempts = 30, delayMs = 2_000): Promise<void> {
  const redis = getRedis();
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      if (redis.status === 'wait' || redis.status === 'end') await redis.connect();
      await redis.ping();
      logger.info('redis', `connected (attempt ${attempt})`);
      return;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (attempt >= maxAttempts) throw new Error(`Redis unavailable after ${maxAttempts} attempts: ${message}`);
      logger.warn('redis', `not ready (${attempt}/${maxAttempts}), retrying`, { delayMs });
      await sleep(delayMs);
    }
  }
}

export async function pingRedis(): Promise<boolean> {
  try {
    await getRedis().ping();
    return true;
  } catch {
    return false;
  }
}

export async function closeRedis(): Promise<void> {
  if (client) {
    await client.quit().catch(() => undefined);
    client = null;
  }
}
