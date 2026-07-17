/**
 * Reachability routes (all authenticated): manage inbound-call channels and contact
 * share links, and resolve a scanned share token to add the owner as a connection.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter } from '@trustroute/core';
import {
  createChannelBody,
  createShareBody,
  resolveBody,
  channelIdParam,
  shareIdParam,
} from './reachability.schema';
import * as reach from './reachability.service';

const router = Router();
router.use(requireAuth);

// ── Channels ──────────────────────────────────────────────────────────────────
router.get(
  '/channels',
  asyncHandler(async (req, res) => {
    sendOk(res, await reach.listChannels(req.user!.sub));
  }),
);

router.post(
  '/channels',
  validate({ body: createChannelBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await reach.createChannel(req.user!.sub, req.valid.body as Parameters<typeof reach.createChannel>[1]), {
      status: 201,
    });
  }),
);

router.delete(
  '/channels/:channelId',
  validate({ params: channelIdParam }),
  asyncHandler(async (req, res) => {
    const { channelId } = req.valid.params as { channelId: string };
    sendOk(res, await reach.revokeChannel(req.user!.sub, channelId));
  }),
);

// ── Contact shares ──────────────────────────────────────────────────────────
router.get(
  '/shares',
  asyncHandler(async (req, res) => {
    sendOk(res, await reach.listShares(req.user!.sub));
  }),
);

router.post(
  '/shares',
  validate({ body: createShareBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await reach.createShare(req.user!.sub, req.valid.body as Parameters<typeof reach.createShare>[1]), {
      status: 201,
    });
  }),
);

router.delete(
  '/shares/:shareId',
  validate({ params: shareIdParam }),
  asyncHandler(async (req, res) => {
    const { shareId } = req.valid.params as { shareId: string };
    sendOk(res, await reach.revokeShare(req.user!.sub, shareId));
  }),
);

router.post(
  '/resolve',
  validate({ body: resolveBody }),
  asyncHandler(async (req, res) => {
    const { token, deviceHash } = req.valid.body as { token: string; deviceHash?: string };
    sendOk(res, await reach.resolveShare(token, req.user!.sub, deviceHash));
  }),
);

export function register(app: Express): void {
  app.use('/reachability', apiLimiter, router);
}
