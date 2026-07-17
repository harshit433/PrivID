/**
 * Idempotency-Key middleware for money + call mutations.
 *
 * The mobile client retries aggressively on flaky networks (the "200 but client
 * retried" bug). For side-effectful POSTs the client sends a stable
 * `Idempotency-Key`; we replay the first response for any repeat of that key
 * instead of running the mutation twice.
 *
 * State machine per key (Redis, 24h TTL):
 *   absent            -> acquire "pending", run handler, store the completed response
 *   "pending"         -> the original is still in flight: 409 so the client backs off
 *   completed record  -> replay stored { status, body }
 *
 * Fail-open: if Redis is unavailable the request proceeds without dedupe.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getRedis, keys, TTL } from '../cache';
import { AppError } from './errors';
import { logger } from '../logger';

interface StoredResponse {
  s: 'pending' | 'done';
  status?: number;
  body?: unknown;
}

export function idempotency(opts: { required?: boolean } = {}): RequestHandler {
  return async (req: Request, res: Response, next: NextFunction) => {
    const headerKey = req.header('idempotency-key');
    const userId = req.user?.sub;

    if (!headerKey) {
      if (opts.required) {
        return next(new AppError(400, 'VALIDATION_ERROR', 'Idempotency-Key header is required for this request.'));
      }
      return next();
    }
    if (!userId) return next(); // unauthenticated routes don't scope a stable key

    const redisKey = keys.idempotency(userId, headerKey);
    let redis;
    try {
      redis = getRedis();
    } catch {
      return next();
    }

    try {
      const acquired = await redis.set(redisKey, JSON.stringify({ s: 'pending' } satisfies StoredResponse), 'EX', TTL.idempotency, 'NX');
      if (acquired !== 'OK') {
        const raw = await redis.get(redisKey);
        const stored = raw ? (JSON.parse(raw) as StoredResponse) : null;
        if (stored?.s === 'done') {
          res.status(stored.status ?? 200).json(stored.body);
          return;
        }
        return next(new AppError(409, 'CONFLICT', 'A request with this Idempotency-Key is already being processed.'));
      }
    } catch (err) {
      logger.warn('idempotency', 'redis error, proceeding without dedupe', { error: (err as Error).message });
      return next();
    }

    // Capture the terminal response so replays return the same thing.
    const originalJson = res.json.bind(res);
    res.json = ((body: unknown) => {
      const record: StoredResponse = { s: 'done', status: res.statusCode, body };
      // Only persist successful/terminal results; on 5xx clear the lock so a genuine retry can run.
      if (res.statusCode >= 500) {
        redis.del(redisKey).catch(() => undefined);
      } else {
        redis.set(redisKey, JSON.stringify(record), 'EX', TTL.idempotency).catch(() => undefined);
      }
      return originalJson(body);
    }) as Response['json'];

    next();
  };
}
