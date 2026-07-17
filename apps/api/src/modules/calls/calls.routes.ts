/**
 * Calls routes (all authenticated). Initiate carries an Idempotency-Key so a retried
 * "call" POST doesn't double-ring. Everything else is a state transition on a call the
 * caller participates in.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, sendPage, validate, requireAuth, apiLimiter, idempotency } from '@trustroute/core';
import { initiateBody, declineBody, qualityBody, listQuery, callIdParam } from './calls.schema';
import * as calls from './calls.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await calls.history(req.user!.sub, limit, cursor);
    sendPage(res, items, meta);
  }),
);

router.post(
  '/',
  idempotency(),
  validate({ body: initiateBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await calls.initiate(req.user!.sub, req.valid.body as Parameters<typeof calls.initiate>[1]), {
      status: 201,
    });
  }),
);

router.get(
  '/:callId',
  validate({ params: callIdParam }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await calls.get(req.user!.sub, callId));
  }),
);

router.post(
  '/:callId/answer',
  validate({ params: callIdParam }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await calls.answer(req.user!.sub, callId));
  }),
);

router.post(
  '/:callId/decline',
  validate({ params: callIdParam, body: declineBody }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    const { reason } = req.valid.body as { reason?: string };
    sendOk(res, await calls.decline(req.user!.sub, callId, reason));
  }),
);

router.post(
  '/:callId/end',
  validate({ params: callIdParam }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await calls.end(req.user!.sub, callId));
  }),
);

router.post(
  '/:callId/quality',
  validate({ params: callIdParam, body: qualityBody }),
  asyncHandler(async (req, res) => {
    const { callId } = req.valid.params as { callId: string };
    sendOk(res, await calls.submitQuality(req.user!.sub, callId, req.valid.body as Record<string, number>));
  }),
);

export function register(app: Express): void {
  app.use('/calls', apiLimiter, router);
}
