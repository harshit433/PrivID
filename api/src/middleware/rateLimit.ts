import { Request, Response, NextFunction } from 'express';
import { getRedis } from '@privid/shared';
import { AppError } from './errorHandler';

interface RateLimitOptions {
  keyFn: (req: Request) => string;
  windowSeconds: number;
  maxRequests: number;
  errorCode?: string;
  errorMessage?: string;
}

export function rateLimit(opts: RateLimitOptions) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const redis = getRedis();
      const key = `rl:${opts.keyFn(req)}`;
      const count = await redis.incr(key);
      if (count === 1) await redis.expire(key, opts.windowSeconds);
      if (count > opts.maxRequests) {
        return next(
          new AppError(
            429,
            opts.errorCode ?? 'RATE_LIMITED',
            opts.errorMessage ?? `Too many requests. Try again later.`
          )
        );
      }
      next();
    } catch {
      // Redis unavailable — fail open (don't block the request)
      next();
    }
  };
}

// ─── Pre-built limiters ───────────────────────────────────────────────────────

/** 10 requests / minute per IP for public unauthenticated endpoints */
export const publicLimiter = rateLimit({
  keyFn: (req) => `public:${req.ip}`,
  windowSeconds: 60,
  maxRequests: 10,
});

/** 60 requests / minute per authenticated user */
export const apiLimiter = rateLimit({
  keyFn: (req) => `api:${req.user?.sub ?? req.ip}`,
  windowSeconds: 60,
  maxRequests: 60,
});

/**
 * Strict: 5 call initiations / 10 minutes per user.
 * Intentionally unused — trusted contacts bypass call rate limits; unknown-caller
 * throttling is handled inline in routes/calls.ts after connection type is resolved.
 */
export const callLimiter = rateLimit({
  keyFn: (req) => `call:${req.user?.sub ?? req.ip}`,
  windowSeconds: 600,
  maxRequests: 5,
  errorCode: 'CALL_RATE_LIMITED',
  errorMessage: 'You are initiating calls too quickly. Please wait a moment.',
});
