import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

// ─── GET /subscriptions/messages (before /:id) ────────────────────────────────

subscriptionsRouter.get('/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const businessId = req.query.business_id as string | undefined;
    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '30'), 10) || 30));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const rows = await query(
      `SELECT d.delivery_id, d.delivered_at, d.status::text AS delivery_status,
              m.message_id, m.content, m.sent_at, m.created_at AS message_created_at,
              b.business_id, b.name AS business_name, b.logo_url AS business_logo_url,
              b.status::text AS business_status,
              c.channel_id, c.name AS channel_name
       FROM business_message_deliveries d
       JOIN business_messages m ON m.message_id = d.message_id
       JOIN businesses b ON b.business_id = m.business_id
       JOIN business_channels c ON c.channel_id = m.channel_id
       JOIN business_subscriptions s ON s.subscription_id = d.subscription_id
       WHERE d.user_id = $1 AND s.status = 'active' AND d.status = 'delivered'
         ${businessId ? 'AND m.business_id = $4' : ''}
       ORDER BY COALESCE(d.delivered_at, m.created_at) DESC
       LIMIT $2 OFFSET $3`,
      businessId ? [userId, limit, offset, businessId] : [userId, limit, offset],
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.get('/pending', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query(
      `SELECT s.subscription_id, s.channel_id, s.status::text AS status, s.created_at,
              b.business_id, b.name AS business_name, b.logo_url, b.status::text AS business_status,
              c.name AS channel_name, c.channel_type::text AS channel_type
       FROM business_subscriptions s
       JOIN businesses b ON b.business_id = s.business_id
       JOIN business_channels c ON c.channel_id = s.channel_id
       WHERE s.user_id = $1 AND s.status = 'pending'
       ORDER BY s.created_at DESC`,
      [req.user!.sub],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = req.query.status as string | undefined;
    const rows = await query(
      `SELECT s.subscription_id, s.channel_id, s.status::text AS status,
              s.subscribed_at, s.cancelled_at, s.created_at,
              b.business_id, b.name AS business_name, b.logo_url,
              b.status::text AS business_status,
              c.name AS channel_name, c.channel_type::text AS channel_type
       FROM business_subscriptions s
       JOIN businesses b ON b.business_id = s.business_id
       JOIN business_channels c ON c.channel_id = s.channel_id
       WHERE s.user_id = $1
         AND s.status != 'cancelled'
         ${status ? 'AND s.status = $2::business_subscription_status' : ''}
       ORDER BY s.updated_at DESC`,
      status ? [req.user!.sub, status] : [req.user!.sub],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

const respondSchema = z.object({
  action: z.enum(['approve', 'deny']),
});

subscriptionsRouter.post('/:id/respond', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { action } = respondSchema.parse(req.body);
    const sub = await queryOne<{ subscription_id: string; status: string }>(
      `SELECT subscription_id, status::text AS status FROM business_subscriptions
       WHERE subscription_id = $1 AND user_id = $2`,
      [req.params.id, req.user!.sub],
    );
    if (!sub) throw new AppError(404, 'NOT_FOUND', 'Subscription not found.');
    if (sub.status !== 'pending') {
      throw new AppError(409, 'NOT_PENDING', 'Only pending subscriptions can be approved or denied.');
    }

    if (action === 'approve') {
      const [row] = await query(
        `UPDATE business_subscriptions
         SET status = 'active', subscribed_at = NOW(), updated_at = NOW()
         WHERE subscription_id = $1
         RETURNING subscription_id, status::text AS status, subscribed_at`,
        [req.params.id],
      );
      return res.json({ ok: true, data: row });
    }

    const [row] = await query(
      `UPDATE business_subscriptions
       SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE subscription_id = $1
       RETURNING subscription_id, status::text AS status`,
      [req.params.id],
    );
    res.json({ ok: true, data: row });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

subscriptionsRouter.patch('/:id/pause', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [row] = await query(
      `UPDATE business_subscriptions
       SET status = 'paused', updated_at = NOW()
       WHERE subscription_id = $1 AND user_id = $2 AND status = 'active'
       RETURNING subscription_id, status::text AS status`,
      [req.params.id, req.user!.sub],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Active subscription not found.');
    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.delete('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [row] = await query(
      `UPDATE business_subscriptions
       SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
       WHERE subscription_id = $1 AND user_id = $2
         AND status IN ('active', 'paused', 'pending')
       RETURNING subscription_id, status::text AS status`,
      [req.params.id, req.user!.sub],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Subscription not found.');
    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});
