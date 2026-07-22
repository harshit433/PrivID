/**
 * Business routes. Two mounts:
 *   /businesses  — app users (JWT): register, directory, subscribe, inbox, block/report
 *   /business    — operators (API key): profile, channels, broadcast
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, sendPage, validate, requireAuth, apiLimiter } from '@trustroute/core';
import {
  registerBody,
  subscribeBody,
  blockBody,
  reportBody,
  createChannelBody,
  broadcastBody,
  inboxQuery,
  businessIdParam,
  subIdParam,
  channelIdParam,
  counterQrBody,
} from './business.schema';
import { requireBusiness } from './business.guard';
import * as business from './business.service';

// ── App-user surface ─────────────────────────────────────────────────────────
const userRouter = Router();
userRouter.use(requireAuth);

userRouter.get('/', asyncHandler(async (req, res) => sendOk(res, await business.directory(req.user!.sub))));

userRouter.post(
  '/register',
  validate({ body: registerBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await business.register(req.valid.body as Parameters<typeof business.register>[0]), { status: 201 });
  }),
);

userRouter.get(
  '/inbox',
  validate({ query: inboxQuery }),
  asyncHandler(async (req, res) => {
    const { limit, cursor } = req.valid.query as { limit: number; cursor?: string };
    const { items, meta } = await business.inbox(req.user!.sub, limit, cursor);
    sendPage(res, items, meta);
  }),
);

userRouter.post(
  '/:businessId/subscribe',
  validate({ params: businessIdParam, body: subscribeBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = req.valid.params as { businessId: string };
    const { channelId } = req.valid.body as { channelId: string };
    sendOk(res, await business.subscribe(req.user!.sub, businessId, channelId), { status: 201 });
  }),
);

userRouter.post(
  '/subscriptions/:subscriptionId/unsubscribe',
  validate({ params: subIdParam }),
  asyncHandler(async (req, res) => {
    const { subscriptionId } = req.valid.params as { subscriptionId: string };
    sendOk(res, await business.unsubscribe(req.user!.sub, subscriptionId));
  }),
);

userRouter.post(
  '/:businessId/block',
  validate({ params: businessIdParam, body: blockBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = req.valid.params as { businessId: string };
    const { reason } = req.valid.body as { reason?: string };
    sendOk(res, await business.block(req.user!.sub, businessId, reason));
  }),
);

userRouter.post(
  '/:businessId/unblock',
  validate({ params: businessIdParam }),
  asyncHandler(async (req, res) => {
    const { businessId } = req.valid.params as { businessId: string };
    sendOk(res, await business.unblock(req.user!.sub, businessId));
  }),
);

userRouter.post(
  '/:businessId/report',
  validate({ params: businessIdParam, body: reportBody }),
  asyncHandler(async (req, res) => {
    const { businessId } = req.valid.params as { businessId: string };
    const { reason } = req.valid.body as { reason?: string };
    sendOk(res, await business.report(req.user!.sub, businessId, reason));
  }),
);

// ── Operator surface (API key) ────────────────────────────────────────────────
const opRouter = Router();
opRouter.use(requireBusiness);

opRouter.get('/me', asyncHandler(async (req, res) => sendOk(res, business.me(req.business!))));

opRouter.get('/channels', asyncHandler(async (req, res) => sendOk(res, await business.channels(req.business!))));

opRouter.post(
  '/channels',
  validate({ body: createChannelBody }),
  asyncHandler(async (req, res) => {
    sendOk(res, await business.createChannel(req.business!, req.valid.body as Parameters<typeof business.createChannel>[1]), { status: 201 });
  }),
);

opRouter.post(
  '/channels/:channelId/messages',
  validate({ params: channelIdParam, body: broadcastBody }),
  asyncHandler(async (req, res) => {
    const { channelId } = req.valid.params as { channelId: string };
    const { content, templateId } = req.valid.body as { content: string; templateId?: string };
    sendOk(res, await business.broadcast(req.business!, channelId, content, templateId), { status: 201 });
  }),
);

opRouter.get(
  '/channels/:channelId/messages',
  validate({ params: channelIdParam }),
  asyncHandler(async (req, res) => {
    const { channelId } = req.valid.params as { channelId: string };
    sendOk(res, await business.channelMessages(req.business!, channelId));
  }),
);

/** Mint rotating counter QR for a channel (also exposed under /subscriptions/counter-qr for Scan app). */
opRouter.post(
  '/counter-qr',
  validate({ body: counterQrBody }),
  asyncHandler(async (req, res) => {
    const { channelId } = req.valid.body as { channelId: string };
    sendOk(res, await business.mintCounterQr(req.business!, channelId));
  }),
);

export function register(app: Express): void {
  app.use('/businesses', apiLimiter, userRouter);
  app.use('/business', opRouter);
}
