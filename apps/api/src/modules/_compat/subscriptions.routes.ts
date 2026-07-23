/**
 * Legacy `/subscriptions/*` compatibility → v2 `/businesses` service. The mobile app's
 * "company updates" surface (inbox, subscribed channels, respond/pause/resume/read a
 * subscription, block/report a business) predates the v2 `/businesses` grouping.
 *
 * Counter QR flow (business-scan shows QR → customer confirms):
 *   POST /subscriptions/counter-qr     (API key)  → mint
 *   POST /subscriptions/qr/resolve     (JWT)      → peek
 *   POST /subscriptions/qr/subscribe   (JWT)      → consume + active sub
 */
import { Router, type Express } from 'express';
import {
  asyncHandler,
  sendOk,
  sendPage,
  requireAuth,
  apiLimiter,
  appError,
  db,
  businessSubscriptions,
  eq,
  and,
  sql,
  validate,
} from '@trustroute/core';
import * as biz from '../business/business.service';
import { requireBusiness } from '../business/business.guard';
import { counterQrBody, qrTokenBody } from '../business/business.schema';

// ── API-key mint (business-scan) ──────────────────────────────────────────────
// Auth only on this route — do not `use(requireBusiness)` on a /subscriptions
// router, or every consumer JWT call (inbox, etc.) would fail with "API key required".
const counterQrRouter = Router();
counterQrRouter.post(
  '/counter-qr',
  requireBusiness,
  validate({ body: counterQrBody }),
  asyncHandler(async (req, res) => {
    const { channelId } = req.valid.body as { channelId: string };
    sendOk(res, await biz.mintCounterQr(req.business!, channelId));
  }),
);

// ── JWT consumer surface ──────────────────────────────────────────────────────
const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

router.post(
  '/qr/resolve',
  validate({ body: qrTokenBody }),
  asyncHandler(async (req, res) => {
    const { token } = req.valid.body as { token: string };
    sendOk(res, await biz.resolveCounterQr(uid(req), token));
  }),
);

router.post(
  '/qr/subscribe',
  validate({ body: qrTokenBody }),
  asyncHandler(async (req, res) => {
    const { token } = req.valid.body as { token: string };
    sendOk(res, await biz.subscribeCounterQr(uid(req), token), { status: 201 });
  }),
);

router.get('/inbox', asyncHandler(async (req, res) => {
  const { items, meta } = await biz.inbox(uid(req), 30, req.query.cursor as string | undefined);
  sendPage(res, items, meta);
}));
router.get('/messages', asyncHandler(async (req, res) => {
  const { items, meta } = await biz.inbox(uid(req), 30, req.query.cursor as string | undefined);
  sendPage(res, items, meta);
}));
// These three used to all return `directory()` — a list of *businesses*, which
// has no subscriptionId, so the app could not render or act on a subscription.
const SUB_STATUS = new Set(['pending', 'active', 'paused', 'cancelled']);
router.get('/', asyncHandler(async (req, res) => {
  const q = req.query.status as string | undefined;
  sendOk(res, await biz.mySubscriptions(uid(req), SUB_STATUS.has(q ?? '') ? (q as 'active') : undefined));
}));
router.get('/pending', asyncHandler(async (req, res) => sendOk(res, await biz.mySubscriptions(uid(req), 'pending'))));
router.get('/blocked', asyncHandler(async (req, res) => sendOk(res, await biz.myBlocked(uid(req)))));
/** The business catalogue, which `/` no longer serves. */
router.get('/directory', asyncHandler(async (req, res) => sendOk(res, await biz.directory(uid(req)))));

// Subscription-status changes on the caller's own subscription row.
async function setStatus(userId: string, subscriptionId: string, patch: Record<string, unknown>) {
  const rows = await db
    .update(businessSubscriptions)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(and(eq(businessSubscriptions.subscriptionId, subscriptionId), eq(businessSubscriptions.userId, userId)))
    .returning({ subscriptionId: businessSubscriptions.subscriptionId, status: businessSubscriptions.status });
  if (!rows[0]) throw appError('NOT_FOUND', 'Subscription not found.');
  return rows[0];
}
router.post('/:subscriptionId/respond', asyncHandler(async (req, res) => {
  const { accept } = (req.body ?? {}) as { accept?: boolean };
  sendOk(res, await setStatus(uid(req), req.params.subscriptionId!, accept === false ? { status: 'cancelled', cancelledAt: sql`now()` } : { status: 'active', subscribedAt: sql`now()` }));
}));
router.patch('/:subscriptionId/pause', asyncHandler(async (req, res) => sendOk(res, await setStatus(uid(req), req.params.subscriptionId!, { status: 'paused' }))));
router.patch('/:subscriptionId/resume', asyncHandler(async (req, res) => sendOk(res, await setStatus(uid(req), req.params.subscriptionId!, { status: 'active' }))));
router.patch('/:subscriptionId/read', asyncHandler(async (req, res) => sendOk(res, await setStatus(uid(req), req.params.subscriptionId!, { lastReadAt: sql`now()` }))));
router.delete('/:subscriptionId', asyncHandler(async (req, res) => sendOk(res, await biz.unsubscribe(uid(req), req.params.subscriptionId!))));

router.post('/businesses/:businessId/report', asyncHandler(async (req, res) => sendOk(res, await biz.report(uid(req), req.params.businessId!, (req.body as { reason?: string })?.reason))));
router.post('/businesses/:businessId/block', asyncHandler(async (req, res) => sendOk(res, await biz.block(uid(req), req.params.businessId!, (req.body as { reason?: string })?.reason))));
router.delete('/businesses/:businessId/block', asyncHandler(async (req, res) => sendOk(res, await biz.unblock(uid(req), req.params.businessId!))));

export function register(app: Express): void {
  // Mount API-key mint first so it isn't swallowed by JWT requireAuth.
  app.use('/subscriptions', apiLimiter, counterQrRouter);
  app.use('/subscriptions', apiLimiter, router);
}
