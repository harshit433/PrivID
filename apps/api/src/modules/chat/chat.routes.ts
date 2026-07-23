/**
 * Chat routes. Authenticated surface for tokens + channels; the Stream webhook is
 * public (verified by HMAC signature, not by auth) and reads the captured raw body.
 */
import { Router, type Express, type Request } from 'express';
import { asyncHandler, sendOk, validate, requireAuth, apiLimiter, publicLimiter } from '@trustroute/core';
import { openChannelBody } from './chat.schema';
import * as chat from './chat.service';

const router = Router();
router.use(requireAuth);

router.get(
  '/token',
  asyncHandler(async (req, res) => {
    sendOk(res, await chat.getToken(req.user!.sub));
  }),
);

router.get(
  '/channels',
  asyncHandler(async (req, res) => {
    sendOk(res, await chat.listChannels(req.user!.sub));
  }),
);

router.post(
  '/channels',
  validate({ body: openChannelBody }),
  asyncHandler(async (req, res) => {
    const target = req.valid.body as { handle?: string; otherUserId?: string };
    sendOk(res, await chat.openChannel(req.user!.sub, target), { status: 201 });
  }),
);

// Public webhook (Stream → us), verified by signature.
const webhook = Router();
webhook.post(
  '/webhook',
  asyncHandler(async (req: Request, res) => {
    const raw = (req as Request & { rawBody?: Buffer }).rawBody ?? JSON.stringify(req.body);
    const signature = req.header('x-signature') ?? req.header('x-webhook-signature') ?? '';
    sendOk(res, await chat.handleWebhook(raw, signature, req.body));
  }),
);

export function register(app: Express): void {
  // Webhook first: it's signature-verified, not auth'd. Mounting it before the
  // authenticated router keeps that router's requireAuth from intercepting it.
  app.use('/chat', publicLimiter, webhook);
  app.use('/chat', apiLimiter, router);
}
