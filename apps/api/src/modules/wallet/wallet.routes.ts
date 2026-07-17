/**
 * Wallet routes. Authenticated surface for balance/ledger/top-up (top-up + verify carry
 * an Idempotency-Key); the Razorpay webhook is public and signature-verified.
 */
import { Router, type Express, type Request } from 'express';
import { asyncHandler, sendOk, sendPage, validate, requireAuth, apiLimiter, publicLimiter, idempotency } from '@trustroute/core';
import { listQuery, topupBody, verifyBody, autoRechargeBody } from './wallet.schema';
import { PACKS } from './wallet.service';
import * as wallet from './wallet.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/',
  asyncHandler(async (req, res) => {
    sendOk(res, await wallet.getBalance(req.user!.sub));
  }),
);

router.get('/packs', asyncHandler(async (_req, res) => {
  sendOk(res, { packs: Object.entries(PACKS).map(([id, p]) => ({ packId: id, ...p })) });
}));

router.get(
  '/transactions',
  validate({ query: listQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await wallet.transactions(req.user!.sub, limit, cursor);
    sendPage(res, items, meta);
  }),
);

router.post(
  '/topup',
  idempotency(),
  validate({ body: topupBody }),
  asyncHandler(async (req, res) => {
    const { packId } = req.valid.body as { packId: string };
    sendOk(res, await wallet.createTopupOrder(req.user!.sub, packId), { status: 201 });
  }),
);

router.post(
  '/topup/verify',
  idempotency(),
  validate({ body: verifyBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await wallet.verifyTopup(req.user!.sub, req.valid.body as Parameters<typeof wallet.verifyTopup>[1]));
  }),
);

router.put(
  '/auto-recharge',
  validate({ body: autoRechargeBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await wallet.setAutoRecharge(req.user!.sub, req.valid.body as Parameters<typeof wallet.setAutoRecharge>[1]));
  }),
);

router.get(
  '/subscription',
  asyncHandler(async (req, res) => {
    sendOk(res, await wallet.subscription(req.user!.sub));
  }),
);

// Public webhook (Razorpay → us), signature-verified. Mounted before the auth router.
const webhook = Router();
webhook.post(
  '/webhook',
  asyncHandler(async (req: Request, res) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? JSON.stringify(req.body);
    const signature = req.header('x-razorpay-signature') ?? '';
    sendOk(res, await wallet.handleWebhook(raw, signature, req.body));
  }),
);

export function register(app: Express): void {
  app.use('/wallet', publicLimiter, webhook);
  app.use('/wallet', apiLimiter, router);
}
