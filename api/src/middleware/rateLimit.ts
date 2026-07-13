import { Request, Response, NextFunction } from 'express';
import { getRedis } from '@trustroute/shared';
import { AppError } from './errorHandler';

interface RateLimitOptions {
  keyFn: (req: Request) => string;
  windowSeconds: number;
  maxRequests: number;
  errorCode?: string;
  errorMessage?: string;
}

const INCR_WITH_EXPIRE = `
  local count = redis.call('INCR', KEYS[1])
  if count == 1 then
    redis.call('EXPIRE', KEYS[1], ARGV[1])
  end
  return count
`;

export function rateLimit(opts: RateLimitOptions) {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const redis = getRedis();
      const key = `rl:${opts.keyFn(req)}`;
      const count = (await redis.eval(
        INCR_WITH_EXPIRE,
        1,
        key,
        String(opts.windowSeconds),
      )) as number;
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

/** 30 requests / minute per IP for public unauthenticated endpoints (login + handle check). */
export const publicLimiter = rateLimit({
  keyFn: (req) => `public:${req.ip}`,
  windowSeconds: 60,
  maxRequests: 30,
});

/** 180 requests / minute per authenticated user (chat polls + app sync). */
export const apiLimiter = rateLimit({
  keyFn: (req) => `api:${req.user?.sub ?? req.ip}`,
  windowSeconds: 60,
  maxRequests: 180,
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

/** 40 chat sends / minute per user (REST + WS share Redis counter). */
export const chatSendLimiter = rateLimit({
  keyFn: (req) => `chat-send:${req.user?.sub ?? req.ip}`,
  windowSeconds: 60,
  maxRequests: 40,
  errorCode: 'CHAT_RATE_LIMITED',
  errorMessage: 'You are sending messages too quickly. Please slow down.',
});

export async function checkChatSendRate(userId: string): Promise<void> {
  try {
    const redis = getRedis();
    const key = `rl:chat-send:${userId}`;
    const count = (await redis.eval(INCR_WITH_EXPIRE, 1, key, '60')) as number;
    if (count > 40) {
      throw new AppError(429, 'CHAT_RATE_LIMITED', 'You are sending messages too quickly. Please slow down.');
    }
  } catch (e) {
    if (e instanceof AppError) throw e;
    // Redis down — fail open
  }
}
