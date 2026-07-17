/**
 * Masked-calling routes (all authenticated). Initiate carries an Idempotency-Key so a
 * retried dial doesn't lease two numbers / place two calls.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, sendPage, validate, requireAuth, apiLimiter, idempotency } from '@trustroute/core';
import { initiateBody, reportBody, listQuery, callIdParam } from './masked.schema';
import * as masked from './masked.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await masked.history(req.user!.sub, limit, cursor);
    sendPage(res, items, meta);
  }),
);

router.post(
  '/',
  idempotency(),
  validate({ body: initiateBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await masked.initiate(req.user!.sub, req.valid.body as Parameters<typeof masked.initiate>[1]), {
      status: 201,
    });
  }),
);

router.post(
  '/report',
  validate({ body: reportBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await masked.report(req.user!.sub, req.valid.body as Parameters<typeof masked.report>[1]));
  }),
);

router.get(
  '/:callId',
  validate({ params: callIdParam }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await masked.get(req.user!.sub, callId));
  }),
);

router.post(
  '/:callId/connected',
  validate({ params: callIdParam }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await masked.markConnected(req.user!.sub, callId));
  }),
);

router.post(
  '/:callId/end',
  validate({ params: callIdParam }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await masked.end(req.user!.sub, callId));
  }),
);

export function register(app: Express): void {
  app.use('/masked', apiLimiter, router);
}
