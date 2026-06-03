/**
 * Mount Business API routes on the consumer API (same port / deploy).
 * business-scan and business-dashboard use these paths with x-api-key auth.
 */
import express, { Express } from 'express';
import { businessApiRateLimit } from '../../business-api/src/middleware/rateLimit';
import { meRouter } from '../../business-api/src/routes/me';
import { channelsRouter } from '../../business-api/src/routes/channels';
import { subscriptionsRouter } from '../../business-api/src/routes/subscriptions';
import { messagesRouter } from '../../business-api/src/routes/messages';
import { analyticsRouter } from '../../business-api/src/routes/analytics';

export function mountBusinessSuite(app: Express): void {
  const authed = express.Router();
  authed.use(businessApiRateLimit);
  authed.use('/me', meRouter);
  authed.use('/channels', channelsRouter);
  authed.use('/subscriptions', subscriptionsRouter);
  authed.use('/messages', messagesRouter);
  authed.use('/analytics', analyticsRouter);
  app.use(authed);
}
