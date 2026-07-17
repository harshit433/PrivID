/**
 * Legacy root `/payout-methods/*` and `/payouts` compatibility → v2 referrals payout
 * service (v2 nests these under `/referrals`). Adds/lists/removes payout methods and
 * lists/requests payouts for the caller.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter } from '@trustroute/core';
import * as ref from '../referrals/referrals.service';

const uid = (req: { user?: { sub: string } }) => req.user!.sub;

const methods = Router();
methods.use(requireAuth);
methods.get('/', asyncHandler(async (req, res) => sendOk(res, await ref.listPayoutMethods(uid(req)))));
methods.delete('/:methodId', asyncHandler(async (req, res) => sendOk(res, await ref.removePayoutMethod(uid(req), req.params.methodId!))));
methods.post('/upi', asyncHandler(async (req, res) => {
  const { upiId, holderName, isDefault } = (req.body ?? {}) as { upiId: string; holderName?: string; isDefault?: boolean };
  sendOk(res, await ref.addPayoutMethod(uid(req), { type: 'upi', value: upiId, holderName, isDefault }), { status: 201 });
}));
methods.post('/bank', asyncHandler(async (req, res) => {
  const { accountNumber, ifsc, holderName, isDefault } = (req.body ?? {}) as { accountNumber: string; ifsc?: string; holderName?: string; isDefault?: boolean };
  sendOk(res, await ref.addPayoutMethod(uid(req), { type: 'bank', value: `${accountNumber}${ifsc ? `/${ifsc}` : ''}`, holderName, isDefault }), { status: 201 });
}));
methods.post('/', asyncHandler(async (req, res) => {
  const b = (req.body ?? {}) as { type: 'upi' | 'bank'; value?: string; upiId?: string; holderName?: string; isDefault?: boolean };
  sendOk(res, await ref.addPayoutMethod(uid(req), { type: b.type, value: b.value ?? b.upiId ?? '', holderName: b.holderName, isDefault: b.isDefault }), { status: 201 });
}));

const payouts = Router();
payouts.use(requireAuth);
payouts.get('/', asyncHandler(async (req, res) => sendOk(res, await ref.listPayouts(uid(req)))));
payouts.post('/', asyncHandler(async (req, res) => {
  const { amountPaise, methodId } = (req.body ?? {}) as { amountPaise: number; methodId: string };
  sendOk(res, await ref.requestPayout(uid(req), { amountPaise, methodId }), { status: 201 });
}));

export function register(app: Express): void {
  app.use('/payout-methods', apiLimiter, methods);
  app.use('/payouts', apiLimiter, payouts);
}
