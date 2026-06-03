import { Request, Response, NextFunction } from 'express';
import { getRedis, keys } from '@trustroute/shared';
import { AppError } from './errorHandler';

/** 100 requests / minute per verified business API key. */
export async function businessApiRateLimit(req: Request, _res: Response, next: NextFunction) {
  const businessId = req.business?.business_id;
  if (!businessId) return next();

  try {
    const redis = getRedis();
    const key = keys.bizApiRate(businessId);
    const count = await redis.incr(key);
    if (count === 1) await redis.expire(key, 60);
    if (count > 100) {
      return next(new AppError(429, 'RATE_LIMITED', 'API rate limit exceeded (100 requests/min).'));
    }
    next();
  } catch {
    next();
  }
}
