/**
 * Legacy `/subscriptions/*` compatibility → v2 `/businesses` service. The mobile app's
 * "company updates" surface (inbox, subscribed channels, respond/pause/resume/read a
 * subscription, block/report a business) predates the v2 `/businesses` grouping. Reads and
 * block/report delegate to the business service; subscription-status changes — which v2
 * exposes only implicitly — are applied directly against the subscription row here.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, sendPage, requireAuth, apiLimiter, appError, db, businessSubscriptions, eq, and, sql } from '@trustroute/core';
import * as biz from '../business/business.service';

const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

router.get('/inbox', asyncHandler(async (req, res) => {
  const { items, meta } = await biz.inbox(uid(req), 30, req.query.cursor as string | undefined);
  sendPage(res, items, meta);
}));
router.get('/messages', asyncHandler(async (req, res) => {
  const { items, meta } = await biz.inbox(uid(req), 30, req.query.cursor as string | undefined);
  sendPage(res, items, meta);
}));
router.get('/', asyncHandler(async (req, res) => sendOk(res, await biz.directory(uid(req)))));
router.get('/pending', asyncHandler(async (req, res) => sendOk(res, await biz.directory(uid(req)))));
router.get('/blocked', asyncHandler(async (req, res) => sendOk(res, await biz.directory(uid(req)))));

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
  app.use('/subscriptions', apiLimiter, router);
}
