/**
 * Activities routes (all authenticated). Scope + role checks live in the service.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import { startBody, stateBody, presenterBody, activityIdParam } from './activities.schema';
import * as activities from './activities.service';

const router = Router();
router.use(requireAuth);

router.post(
  '/',
  validate({ body: startBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await activities.start(req.user!.sub, req.valid.body as Parameters<typeof activities.start>[1]), {
      status: 201,
    });
  }),
);

router.get(
  '/:activityId',
  validate({ params: activityIdParam }),
  asyncHandler(async (req, res) => {
    const { activityId } = req.valid.params as { activityId: string };
    sendOk(res, await activities.get(req.user!.sub, activityId));
  }),
);

router.post(
  '/:activityId/join',
  validate({ params: activityIdParam }),
  asyncHandler(async (req, res) => {
    const { activityId } = req.valid.params as { activityId: string };
    sendOk(res, await activities.join(req.user!.sub, activityId));
  }),
);

router.post(
  '/:activityId/leave',
  validate({ params: activityIdParam }),
  asyncHandler(async (req, res) => {
    const { activityId } = req.valid.params as { activityId: string };
    sendOk(res, await activities.leave(req.user!.sub, activityId));
  }),
);

router.put(
  '/:activityId/state',
  validate({ params: activityIdParam, body: stateBody }),
  asyncHandler(async (req, res) => {
    const { activityId } = req.valid.params as { activityId: string };
    const { state, baseRevision } = req.valid.body as { state: Record<string, unknown>; baseRevision: number };
    sendOk(res, await activities.updateState(req.user!.sub, activityId, state, baseRevision));
  }),
);

router.put(
  '/:activityId/presenter',
  validate({ params: activityIdParam, body: presenterBody }),
  asyncHandler(async (req, res) => {
    const { activityId } = req.valid.params as { activityId: string };
    const { presenterUserId } = req.valid.body as { presenterUserId: string | null };
    sendOk(res, await activities.setPresenter(req.user!.sub, activityId, presenterUserId));
  }),
);

router.post(
  '/:activityId/end',
  validate({ params: activityIdParam }),
  asyncHandler(async (req, res) => {
    const { activityId } = req.valid.params as { activityId: string };
    sendOk(res, await activities.end(req.user!.sub, activityId));
  }),
);

export function register(app: Express): void {
  app.use('/activities', apiLimiter, router);
}
