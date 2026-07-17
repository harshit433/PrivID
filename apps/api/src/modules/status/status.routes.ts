/**
 * Status routes (all authenticated). `/status/feed` is the connections feed; `/status/me`
 * is the caller's own active updates.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { postBody, statusIdParam } from './status.schema';
import * as status from './status.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/feed',
  asyncHandler(async (req, res) => {
    sendOk(res, await status.feed(req.user!.sub));
  }),
);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    sendOk(res, await status.mine(req.user!.sub));
  }),
);

router.post(
  '/',
  validate({ body: postBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await status.post(req.user!.sub, req.valid.body as Parameters<typeof status.post>[1]), { status: 201 });
  }),
);

router.delete(
  '/:statusId',
  validate({ params: statusIdParam }),
  asyncHandler(async (req, res) => {
    const { statusId } = req.valid.params as { statusId: string };
    sendOk(res, await status.remove(req.user!.sub, statusId));
  }),
);

export function register(app: Express): void {
  app.use('/status', apiLimiter, router);
}
