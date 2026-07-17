/**
 * Reports routes (all authenticated).
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { fileBody } from './reports.schema';
import * as reports from './reports.service';

const router = Router();
router.use(requireAuth);

router.get('/', asyncHandler(async (req, res) => sendOk(res, await reports.mine(req.user!.sub))));

router.post(
  '/',
  validate({ body: fileBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await reports.file(req.user!.sub, req.valid.body as Parameters<typeof reports.file>[1]), { status: 201 });
  }),
);

export function register(app: Express): void {
  app.use('/reports', apiLimiter, router);
}
