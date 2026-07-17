/**
 * Admin routes — all guarded by the shared-secret `x-admin-key` (requireAdmin). An
 * optional `x-admin-actor` header labels the acting operator in the audit log.
 */
import { Router, type Express, type Request } from 'express';
import { asyncHandler, sendOk, sendPage, validate, requireAdmin, paginationQuery } from '@trustroute/core';
import { z } from 'zod';
import * as admin from './admin.service';

const actor = (req: Request) => req.header('x-admin-actor') ?? 'admin';

const userIdParam = z.object({ userId: z.string().uuid() });
const businessIdParam = z.object({ businessId: z.string().uuid() });
const appealIdParam = z.object({ appealId: z.string().uuid() });
const moderateBody = z.object({
  action: z.enum(['suspend', 'ban', 'restrict', 'review', 'restore']),
  reason: z.string().trim().max(1000).optional(),
});
const resolveAppealBody = z.object({
  status: z.enum(['in_review', 'restored', 'upheld', 'rejected']),
  resolution: z.string().trim().max(1000).optional(),
  reviewerMessage: z.string().trim().max(1000).optional(),
});
const rejectBody = z.object({ reason: z.string().trim().min(1).max(1000) });

const router = Router();
router.use(requireAdmin);

router.get(
  '/reports',
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await admin.reports(limit, cursor);
    sendPage(res, items, meta);
  }),
);

router.get(
  '/actions',
  validate({ query: paginationQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await admin.actions(limit, cursor);
    sendPage(res, items, meta);
  }),
);

router.get(
  '/users/:userId',
  validate({ params: userIdParam }),
  asyncHandler(async (req, res) => {
    const { userId } = req.valid.params as { userId: string };
    sendOk(res, await admin.getUser(userId));
  }),
);

router.post(
  '/users/:userId/moderate',
  validate({ params: userIdParam, body: moderateBody }),
  asyncHandler(async (req, res) => {
    const { userId } = req.valid.params as { userId: string };
    const { action, reason } = req.valid.body as { action: admin.ModerationAction; reason?: string };
    sendOk(res, await admin.moderateUser(actor(req), userId, action, reason));
  }),
);

router.get(
  '/appeals',
  asyncHandler(async (req, res) => {
    sendOk(res, await admin.appeals(typeof req.query.status === 'string' ? req.query.status : undefined));
  }),
);

router.post(
  '/appeals/:appealId/resolve',
  validate({ params: appealIdParam, body: resolveAppealBody }),
  asyncHandler(async (req, res) => {
    const { appealId } = req.valid.params as { appealId: string };
    sendOk(res, await admin.resolveAppeal(actor(req), appealId, req.valid.body as Parameters<typeof admin.resolveAppeal>[2]));
  }),
);

router.get('/businesses/pending', asyncHandler(async (_req, res) => sendOk(res, await admin.pendingBusinesses())));

router.post(
  '/businesses/:businessId/verify',
  validate({ params: businessIdParam }),
  asyncHandler(async (req, res) => {
    const { businessId } = req.valid.params as { businessId: string };
    sendOk(res, await admin.verifyBusiness(actor(req), businessId), { status: 201 });
  }),
);

router.post(
  '/businesses/:businessId/reject',
  validate({ params: businessIdParam, body: rejectBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = req.valid.params as { businessId: string };
    const { reason } = req.valid.body as { reason: string };
    sendOk(res, await admin.rejectBusiness(actor(req), businessId, reason));
  }),
);

export function register(app: Express): void {
  app.use('/admin', router);
}
