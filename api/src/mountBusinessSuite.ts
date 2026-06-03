/**
 * Mount Business API routes on the consumer API (same port / deploy).
 * business-scan and business-dashboard use these paths with x-api-key auth.
 */
import express, { Express, Router, Request, Response, NextFunction } from 'express';
import { businessApiRateLimit } from '../../business-api/src/middleware/rateLimit';
import { meRouter } from '../../business-api/src/routes/me';
import { channelsRouter as businessChannelsRouter } from '../../business-api/src/routes/channels';
import { subscriptionsRouter as businessSubscriptionsRouter } from '../../business-api/src/routes/subscriptions';
import { messagesRouter } from '../../business-api/src/routes/messages';
import { analyticsRouter } from '../../business-api/src/routes/analytics';

export { businessChannelsRouter, businessSubscriptionsRouter };

/** Consumer + business share /channels and /subscriptions — route by x-api-key vs JWT. */
export function routeByApiKey(businessRouter: Router, consumerRouter: Router): Router {
  const router = Router({ mergeParams: true });
  router.use((req: Request, res: Response, next: NextFunction) => {
    const raw = req.headers['x-api-key'];
    if (typeof raw === 'string' && raw.trim().length >= 16) {
      return businessRouter(req, res, next);
    }
    return consumerRouter(req, res, next);
  });
  return router;
}

export function mountBusinessSuite(app: Express): void {
  const authed = express.Router();
  authed.use(businessApiRateLimit);
  authed.use('/me', meRouter);
  authed.use('/messages', messagesRouter);
  authed.use('/analytics', analyticsRouter);
  app.use(authed);
}
