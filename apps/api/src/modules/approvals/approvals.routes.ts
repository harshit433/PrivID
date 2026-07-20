/**
 * Approval routes (all authenticated). A user lists their pending approval requests
 * and approves / denies them in-app — the numberless-OTP flow. Creating a request is
 * authenticated today (TrustRoute's own step-up); a partner relying-party API with
 * per-RP credentials is the deferred B2B piece.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import {
  createApprovalBody,
  respondApprovalBody,
  listApprovalsQuery,
  approvalIdParam,
} from './approvals.schema';
import * as svc from './approvals.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  validate({ query: listApprovalsQuery }),
  asyncHandler(async (req, res) => {
    const { status } = req.valid.query as { status?: 'pending' | 'approved' | 'denied' | 'expired' };
    sendOk(res, await svc.listRequests(req.user!.sub, status));
  }),
);

router.post(
  '/',
  validate({ body: createApprovalBody }),
  asyncHandler(async (req, res) => {
    sendOk(
      res,
      await svc.createRequest(req.user!.sub, req.valid.body as Parameters<typeof svc.createRequest>[1]),
      { status: 201 },
    );
  }),
);

router.get(
  '/:requestId',
  validate({ params: approvalIdParam }),
  asyncHandler(async (req, res) => {
    const { requestId } = req.valid.params as { requestId: string };
    sendOk(res, await svc.getRequest(req.user!.sub, requestId));
  }),
);

router.post(
  '/:requestId/respond',
  validate({ params: approvalIdParam, body: respondApprovalBody }),
  asyncHandler(async (req, res) => {
    const { requestId } = req.valid.params as { requestId: string };
    const { decision } = req.valid.body as { decision: 'approve' | 'deny' };
    sendOk(res, await svc.respond(req.user!.sub, requestId, decision));
  }),
);

export function register(app: Express): void {
  app.use('/approvals', apiLimiter, router);
}
