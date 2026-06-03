import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, getRedis, keys, sendBusinessSubscriptionRequestPush, PLAN_LIMITS } from '@trustroute/shared';
import { requireApiKey } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireApiKey);

const scanSchema = z.object({
  token: z.string().uuid(),
  channel_id: z.string().uuid(),
});

subscriptionsRouter.post('/scan', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { token, channel_id } = scanSchema.parse(req.body);
    const businessId = req.business!.business_id;

    const channel = await queryOne<{
      channel_id: string;
      name: string;
      business_id: string;
      active: boolean;
    }>(
      `SELECT channel_id, name, business_id, active FROM business_channels
       WHERE channel_id = $1 AND business_id = $2`,
      [channel_id, businessId],
    );
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');
    if (!channel.active) throw new AppError(400, 'CHANNEL_INACTIVE', 'Channel is not active.');

    const redis = getRedis();
    const qrKey = keys.bizQr(token);
    const userId = await redis.get(qrKey);
    if (!userId) {
      throw new AppError(400, 'INVALID_TOKEN', 'QR token is invalid or expired.');
    }
    await redis.del(qrKey);

    const user = await queryOne<{ user_id: string; fcm_token: string | null; display_name: string | null }>(
      `SELECT user_id, fcm_token, display_name FROM users WHERE user_id = $1 AND is_active = TRUE`,
      [userId],
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found or inactive.');

    const existing = await queryOne<{ subscription_id: string; status: string }>(
      `SELECT subscription_id, status::text AS status FROM business_subscriptions
       WHERE user_id = $1 AND channel_id = $2`,
      [userId, channel_id],
    );

    if (existing?.status === 'active') {
      return res.json({
        ok: true,
        data: { subscription_id: existing.subscription_id, status: 'active', already_subscribed: true },
      });
    }

    if (existing?.status === 'pending') {
      return res.json({
        ok: true,
        data: { subscription_id: existing.subscription_id, status: 'pending' },
      });
    }

    const plan = req.business!.plan as keyof typeof PLAN_LIMITS;
    const maxSubs = PLAN_LIMITS[plan]?.maxSubscribers ?? PLAN_LIMITS.starter.maxSubscribers;
    const [subTotal] = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM business_subscriptions
       WHERE business_id = $1 AND status = 'active'`,
      [businessId],
    );
    if (parseInt(subTotal?.n ?? '0', 10) >= maxSubs) {
      throw new AppError(403, 'PLAN_LIMIT', 'Active subscriber limit reached for your plan.');
    }

    const [sub] = await query<{ subscription_id: string; status: string }>(
      `INSERT INTO business_subscriptions (user_id, business_id, channel_id, status)
       VALUES ($1, $2, $3, 'pending')
       ON CONFLICT (user_id, channel_id) DO UPDATE
         SET status = 'pending', cancelled_at = NULL, updated_at = NOW()
       RETURNING subscription_id, status::text AS status`,
      [userId, businessId, channel_id],
    );

    if (user.fcm_token) {
      await sendBusinessSubscriptionRequestPush(user.fcm_token, {
        subscription_id: sub.subscription_id,
        business_id: businessId,
        business_name: req.business!.name,
        channel_id,
        channel_name: channel.name,
        is_verified: true,
      });
    }

    res.status(201).json({
      ok: true,
      data: {
        subscription_id: sub.subscription_id,
        status: sub.status,
        user_display_name: user.display_name,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

subscriptionsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.business!.business_id;
    const statusFilter = req.query.status as string | undefined;
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const rows = await query(
      `SELECT s.subscription_id, s.user_id, s.channel_id, s.status::text AS status,
              s.subscribed_at, s.created_at,
              u.handle, u.display_name, u.avatar_url,
              c.name AS channel_name
       FROM business_subscriptions s
       JOIN users u ON u.user_id = s.user_id
       JOIN business_channels c ON c.channel_id = s.channel_id
       WHERE s.business_id = $1
         ${statusFilter ? 'AND s.status = $4::business_subscription_status' : ''}
       ORDER BY s.updated_at DESC
       LIMIT $2 OFFSET $3`,
      statusFilter
        ? [businessId, limit, offset, statusFilter]
        : [businessId, limit, offset],
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});
