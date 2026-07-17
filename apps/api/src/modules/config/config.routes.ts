/**
 * Config routes. Public GET for the client bootstrap payload; admin-guarded writes to
 * the feature-flag store.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAdmin, publicLimiter } from '@trustroute/core';
import { z } from 'zod';
import * as config from './config.service';

const flagBody = z.object({ value: z.unknown() });
const keyParam = z.object({ key: z.string().min(1).max(80).regex(/^[a-z0-9_]+$/) });

const router = Router();

router.get('/', asyncHandler(async (_req, res) => sendOk(res, await config.clientConfig())));

router.put(
  '/flags/:key',
  requireAdmin,
  validate({ params: keyParam, body: flagBody }),
  asyncHandler(async (req, res) => {
    const { key } = req.valid.params as { key: string };
    const { value } = req.valid.body as { value: unknown };
    sendOk(res, await config.setFlag(key, value));
  }),
);

router.delete(
  '/flags/:key',
  requireAdmin,
  validate({ params: keyParam }),
  asyncHandler(async (req, res) => {
    const { key } = req.valid.params as { key: string };
    sendOk(res, await config.deleteFlag(key));
  }),
);

export function register(app: Express): void {
  app.use('/config', publicLimiter, router);
}
