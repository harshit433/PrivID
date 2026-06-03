import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '@trustroute/shared';
import { requireApiKey } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const analyticsRouter = Router();
analyticsRouter.use(requireApiKey);

analyticsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.business!.business_id;

    const overview = await queryOne<{
      total_subscribers: string;
      pending_subscribers: string;
      messages_sent_30d: string;
      delivered_30d: string;
      failed_30d: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM business_subscriptions
          WHERE business_id = $1 AND status = 'active') AS total_subscribers,
         (SELECT COUNT(*)::text FROM business_subscriptions
          WHERE business_id = $1 AND status = 'pending') AS pending_subscribers,
         (SELECT COUNT(*)::text FROM business_messages
          WHERE business_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS messages_sent_30d,
         (SELECT COALESCE(SUM(total_delivered), 0)::text FROM business_messages
          WHERE business_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS delivered_30d,
         (SELECT COALESCE(SUM(total_failed), 0)::text FROM business_messages
          WHERE business_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS failed_30d`,
      [businessId],
    );

    const growth = await query(
      `SELECT DATE(subscribed_at) AS day, COUNT(*)::int AS new_subscribers
       FROM business_subscriptions
       WHERE business_id = $1 AND status = 'active'
         AND subscribed_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(subscribed_at)
       ORDER BY day ASC`,
      [businessId],
    );

    const delivered = parseInt(overview?.delivered_30d ?? '0', 10);
    const failed = parseInt(overview?.failed_30d ?? '0', 10);
    const attempts = delivered + failed;

    res.json({
      ok: true,
      data: {
        total_active_subscribers: parseInt(overview?.total_subscribers ?? '0', 10),
        pending_subscribers: parseInt(overview?.pending_subscribers ?? '0', 10),
        messages_sent_30d: parseInt(overview?.messages_sent_30d ?? '0', 10),
        delivery_rate_30d: attempts > 0 ? Math.round((delivered / attempts) * 1000) / 10 : null,
        subscriber_growth_30d: growth,
      },
    });
  } catch (err) {
    next(err);
  }
});

analyticsRouter.get('/channels/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.business!.business_id;
    const channelId = req.params.id;

    const channel = await queryOne(
      `SELECT channel_id, name FROM business_channels
       WHERE channel_id = $1 AND business_id = $2`,
      [channelId, businessId],
    );
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');

    const stats = await queryOne<{
      active_subscribers: string;
      messages_30d: string;
      delivered_30d: string;
      failed_30d: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM business_subscriptions
          WHERE channel_id = $1 AND status = 'active') AS active_subscribers,
         (SELECT COUNT(*)::text FROM business_messages
          WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS messages_30d,
         (SELECT COALESCE(SUM(total_delivered), 0)::text FROM business_messages
          WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS delivered_30d,
         (SELECT COALESCE(SUM(total_failed), 0)::text FROM business_messages
          WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS failed_30d`,
      [channelId],
    );

    const daily = await query(
      `SELECT DATE(created_at) AS day,
              COUNT(*)::int AS messages,
              COALESCE(SUM(total_delivered), 0)::int AS delivered
       FROM business_messages
       WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [channelId],
    );

    const delivered = parseInt(stats?.delivered_30d ?? '0', 10);
    const failed = parseInt(stats?.failed_30d ?? '0', 10);
    const attempts = delivered + failed;

    res.json({
      ok: true,
      data: {
        channel,
        active_subscribers: parseInt(stats?.active_subscribers ?? '0', 10),
        messages_sent_30d: parseInt(stats?.messages_30d ?? '0', 10),
        delivery_rate_30d: attempts > 0 ? Math.round((delivered / attempts) * 1000) / 10 : null,
        daily_messages_30d: daily,
      },
    });
  } catch (err) {
    next(err);
  }
});
