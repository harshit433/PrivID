/**
 * Legacy `/shares/*` compatibility → v2 `/reachability` contact-share service. The mobile
 * app calls these to mint/list/revoke disposable share handles and resolve a scanned one.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter } from '@trustroute/core';
import * as reach from '../reachability/reachability.service';

const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

router.get('/', asyncHandler(async (req, res) => sendOk(res, await reach.listShares(uid(req)))));
router.get('/qr', asyncHandler(async (req, res) => sendOk(res, await reach.listShares(uid(req)))));
router.post('/', asyncHandler(async (req, res) => sendOk(res, await reach.createShare(uid(req), req.body as Parameters<typeof reach.createShare>[1]), { status: 201 })));
router.delete('/:shareId', asyncHandler(async (req, res) => sendOk(res, await reach.revokeShare(uid(req), req.params.shareId!))));
router.post('/:token/resolve', asyncHandler(async (req, res) => {
  const { deviceHash } = (req.body ?? {}) as { deviceHash?: string };
  sendOk(res, await reach.resolveShare(req.params.token!, uid(req), deviceHash));
}));
router.post('/links/resolve', asyncHandler(async (req, res) => {
  const { token, deviceHash } = (req.body ?? {}) as { token: string; deviceHash?: string };
  sendOk(res, await reach.resolveShare(token, uid(req), deviceHash));
}));

export function register(app: Express): void {
  app.use('/shares', apiLimiter, router);
}
