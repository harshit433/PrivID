/**
 * Legacy `/referrals/*` compatibility for the paths the mobile app uses that differ from
 * v2's native `/referrals/{code,status,payout-methods,payouts}`. Mounted AFTER the native
 * referrals router, so it only handles the fall-through legacy paths (me / validate /
 * wallet). Qualification (pending → withdrawable) is worker-driven in v2, so `wallet/convert`
 * just returns the current status rather than forcing a conversion.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter, appError } from '@trustroute/core';
import * as ref from '../referrals/referrals.service';

const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

async function overview(userId: string) {
  const [code, status] = await Promise.all([ref.myCode(userId), ref.status(userId)]);
  return { ...code, ...status };
}
router.get('/me', asyncHandler(async (req, res) => sendOk(res, await overview(uid(req)))));
router.get('/wallet', asyncHandler(async (req, res) => sendOk(res, await ref.status(uid(req)))));
router.post('/wallet/convert', asyncHandler(async (req, res) => sendOk(res, await ref.status(uid(req)))));
router.post('/validate', asyncHandler(async (req, res) => {
  const { code } = (req.body ?? {}) as { code?: string };
  if (!code) throw appError('BAD_REQUEST', 'A referral code is required.');
  sendOk(res, await ref.apply(uid(req), code));
}));

export function register(app: Express): void {
  app.use('/referrals', apiLimiter, router);
}
