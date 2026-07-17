/**
 * Referrals routes (all authenticated): code, apply, status, payout methods + payouts.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter, idempotency } from '@trustroute/core';
import { applyBody, addMethodBody, payoutBody, methodIdParam } from './referrals.schema';
import * as referrals from './referrals.service';

const router = Router();
router.use(requireAuth);

router.get('/code', asyncHandler(async (req, res) => sendOk(res, await referrals.myCode(req.user!.sub))));

router.get('/status', asyncHandler(async (req, res) => sendOk(res, await referrals.status(req.user!.sub))));

router.post(
  '/apply',
  validate({ body: applyBody }),
  asyncHandler(async (req, res) => {
    const { code } = req.valid.body as { code: string };
    sendOk(res, await referrals.apply(req.user!.sub, code), { status: 201 });
  }),
);

router.get('/payout-methods', asyncHandler(async (req, res) => sendOk(res, await referrals.listPayoutMethods(req.user!.sub))));

router.post(
  '/payout-methods',
  validate({ body: addMethodBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await referrals.addPayoutMethod(req.user!.sub, req.valid.body as Parameters<typeof referrals.addPayoutMethod>[1]), { status: 201 });
  }),
);

router.delete(
  '/payout-methods/:methodId',
  validate({ params: methodIdParam }),
  asyncHandler(async (req, res) => {
    const { methodId } = req.valid.params as { methodId: string };
    sendOk(res, await referrals.removePayoutMethod(req.user!.sub, methodId));
  }),
);

router.get('/payouts', asyncHandler(async (req, res) => sendOk(res, await referrals.listPayouts(req.user!.sub))));

router.post(
  '/payouts',
  idempotency(),
  validate({ body: payoutBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await referrals.requestPayout(req.user!.sub, req.valid.body as Parameters<typeof referrals.requestPayout>[1]), { status: 201 });
  }),
);

export function register(app: Express): void {
  app.use('/referrals', apiLimiter, router);
}
