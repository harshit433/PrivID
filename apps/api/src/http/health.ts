import { Router } from 'express';
import { asyncHandler, sendOk, pingDb, pingRedis, providerHealth, config } from '@trustroute/core';

export const healthRouter = Router();

healthRouter.get('/favicon.ico', (_req, res) => res.status(204).end());

healthRouter.get(
  '/health',
  asyncHandler(async (_req, res) => {
    const [db, redis] = await Promise.all([pingDb(), pingRedis()]);
    const healthy = db; // DB is the hard dependency; Redis failures are tolerated (fail-open).
    sendOk(
      res,
      {
        healthy,
        service: 'api',
        env: config.NODE_ENV,
        ts: new Date().toISOString(),
        db_ok: db,
        redis_ok: redis,
        ...providerHealth(),
      },
      { status: healthy ? 200 : 503 },
    );
  }),
);
