/**
 * Legacy `/chats/*` compatibility → v2 `/chat` (Stream-backed). The old backend proxied
 * message send/read/reactions through the DB; v2 delegates all message traffic to the
 * Stream SDK on the client. So only the operations v2 still owns — issuing a token,
 * listing the caller's channels, and opening a 1:1 channel — are re-exposed. Message-level
 * routes return NOT_CONFIGURED to signal the client should use the Stream SDK directly.
 */
import { Router, type Express } from 'express';
import { asyncHandler, sendOk, requireAuth, apiLimiter, appError } from '@trustroute/core';
import * as chat from '../chat/chat.service';

const router = Router();
router.use(requireAuth);
const uid = (req: { user?: { sub: string } }) => req.user!.sub;

router.get('/', asyncHandler(async (req, res) => sendOk(res, await chat.listChannels(uid(req)))));
router.get('/token', asyncHandler(async (req, res) => sendOk(res, await chat.getToken(uid(req)))));
router.post('/open', asyncHandler(async (req, res) => {
  const { handle } = (req.body ?? {}) as { handle: string };
  sendOk(res, await chat.openChannel(uid(req), handle));
}));

// Message traffic is Stream-direct in v2 — the client uses the Stream SDK, not the API.
const streamDirect = asyncHandler(async () => {
  throw appError('NOT_CONFIGURED', 'Chat messages are handled by the Stream SDK directly in v2. Use the Stream client with the token from GET /chats/token.');
});
for (const p of ['/:convId/messages', '/:convId/read', '/:convId/mute', '/:convId/pin', '/:convId/clear', '/:convId/context', '/:convId/media', '/:convId/messages/:msgId/reactions']) {
  router.all(p, streamDirect);
}

export function register(app: Express): void {
  app.use('/chats', apiLimiter, router);
}
