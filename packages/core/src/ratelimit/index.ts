/**
 * Redis fixed-window rate limiter. Fail-open: if Redis is unavailable we never
 * block a request (availability > strictness for this app). One Lua round-trip per
 * check keeps INCR + EXPIRE atomic.
 */
import type { Request, Response, NextFunction, RequestHandler } from 'express';
import { getRedis, keys } from '../cache';
import { appError, type ErrorCode } from '../http/errors';

const INCR_WITH_EXPIRE = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then redis.call('EXPIRE', KEYS[1], ARGV[1]) end
  return count
`;

export interface RateLimitOptions {
  keyFn: (req: Request) => string;
  windowSeconds: number;
  max: number;
  code?: ErrorCode;
  message?: string;
}

export function rateLimit(opts: RateLimitOptions): RequestHandler {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const count = (await getRedis().eval(
        INCR_WITH_EXPIRE,
        1,
        keys.rateLimit(opts.keyFn(req)),
        String(opts.windowSeconds),
      )) as number;
      if (count > opts.max) {
        return next(appError(opts.code ?? 'RATE_LIMITED', opts.message));
      }
      next();
    } catch {
      next(); // fail-open
    }
  };
}

/** Raw counter check for use inside services (e.g. WS message sends). Throws on limit. */
export async function consumeRate(bucket: string, windowSeconds: number, max: number, code: ErrorCode = 'RATE_LIMITED'): Promise<void> {
  try {
    const count = (await getRedis().eval(INCR_WITH_EXPIRE, 1, keys.rateLimit(bucket), String(windowSeconds))) as number;
    if (count > max) throw appError(code);
  } catch (err) {
    if (err && (err as { code?: string }).code) throw err; // rethrow AppError
    // Redis down — fail open
  }
}

// ── Pre-built limiters ────────────────────────────────────────────────────────

/** 30 req / min per IP for public unauthenticated endpoints. */
export const publicLimiter = rateLimit({
  keyFn: (req) => `public:${req.ip}`,
  windowSeconds: 60,
  max: 30,
});

/** 180 req / min per authenticated user (app sync + polls). */
export const apiLimiter = rateLimit({
  keyFn: (req) => `api:${req.user?.sub ?? req.ip}`,
  windowSeconds: 60,
  max: 180,
});
