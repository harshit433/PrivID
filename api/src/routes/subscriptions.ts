import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const subscriptionsRouter = Router();
subscriptionsRouter.use(requireAuth);

const BIZ_SELECT = `b.business_id, b.name AS business_name, b.logo_url AS business_logo_url,
  b.status::text AS business_status, b.verified_handle`;

// ─── GET /subscriptions/inbox ────────────────────────────────────────────────

subscriptionsRouter.get('/inbox', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const userId = req.user!.sub;
    const [subs, pending, messages] = await Promise.all([
      query(
        `SELECT s.subscription_id, s.channel_id, s.status::text AS status, s.last_read_at,
                s.subscribed_at, s.created_at,
                ${BIZ_SELECT},
                c.name AS channel_name, c.channel_type::text AS channel_type
         FROM business_subscriptions s
         JOIN businesses b ON b.business_id = s.business_id
         JOIN business_channels c ON c.channel_id = s.channel_id
         WHERE s.user_id = $1 AND s.status = 'active'
           AND NOT EXISTS (
             SELECT 1 FROM business_blocks bl
              WHERE bl.user_id = $1 AND bl.business_id = s.business_id
           )
         ORDER BY s.updated_at DESC`,
        [userId],
      ),
      query(
        `SELECT s.subscription_id, s.channel_id, s.status::text AS status, s.created_at,
                ${BIZ_SELECT},
                c.name AS channel_name, c.channel_type::text AS channel_type
         FROM business_subscriptions s
         JOIN businesses b ON b.business_id = s.business_id
         JOIN business_channels c ON c.channel_id = s.channel_id
         WHERE s.user_id = $1 AND s.status = 'pending'
         ORDER BY s.created_at DESC`,
        [userId],
      ),
      query(
        `SELECT d.delivery_id, d.delivered_at, m.business_id, m.content, m.created_at AS message_created_at,
                c.channel_type::text AS channel_type
         FROM business_message_deliveries d
         JOIN business_messages m ON m.message_id = d.message_id
         JOIN business_channels c ON c.channel_id = m.channel_id
         JOIN business_subscriptions s ON s.subscription_id = d.subscription_id
         WHERE d.user_id = $1 AND s.status = 'active' AND d.status = 'delivered'
         ORDER BY COALESCE(d.delivered_at, m.created_at) DESC
         LIMIT 100`,
        [userId],
      ),
    ]);

    const latestByBiz = new Map<string, { content: string; at: string; channel_type: string }>();
    for (const m of messages) {
      if (!latestByBiz.has(m.business_id)) {
        latestByBiz.set(m.business_id, {
          content: m.content,
          at: m.delivered_at ?? m.message_created_at,
          channel_type: m.channel_type,
        });
      }
    }

    const inbox = subs.map((s: Record<string, unknown>) => {
      const latest = latestByBiz.get(s.business_id as string);
      const lastRead = s.last_read_at ? new Date(s.last_read_at as string).getTime() : 0;
      const latestAt = latest ? new Date(latest.at).getTime() : 0;
      return {
        ...s,
        latest_preview: latest?.content ?? 'No messages yet',
        latest_at: latest?.at ?? null,
        unread: latestAt > lastRead,
      };
    });

    res.json({
      ok: true,
      data: {
        inbox,
        pending_count: pending.length,
        pending,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /subscriptions/blocked ──────────────────────────────────────────────

subscriptionsRouter.get('/blocked', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query(
      `SELECT bl.block_id, bl.business_id, bl.reason, bl.created_at,
              b.name AS business_name, b.logo_url, b.verified_handle, b.status::text AS business_status
       FROM business_blocks bl
       JOIN businesses b ON b.business_id = bl.business_id
       WHERE bl.user_id = $1
       ORDER BY bl.created_at DESC`,
      [req.user!.sub],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

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
              b.status::text AS business_status, b.verified_handle,
              c.channel_id, c.name AS channel_name, c.channel_type::text AS channel_type
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
              ${BIZ_SELECT},
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
              s.subscribed_at, s.cancelled_at, s.created_at, s.last_read_at,
              ${BIZ_SELECT},
              c.name AS channel_name, c.channel_type::text AS channel_type
       FROM business_subscriptions s
       JOIN businesses b ON b.business_id = s.business_id
       JOIN business_channels c ON c.channel_id = s.channel_id
       WHERE s.user_id = $1
         AND s.status != 'cancelled'
         AND NOT EXISTS (
           SELECT 1 FROM business_blocks bl
            WHERE bl.user_id = $1 AND bl.business_id = s.business_id
         )
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

subscriptionsRouter.patch('/:id/resume', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [row] = await query(
      `UPDATE business_subscriptions
       SET status = 'active', updated_at = NOW()
       WHERE subscription_id = $1 AND user_id = $2 AND status = 'paused'
       RETURNING subscription_id, status::text AS status`,
      [req.params.id, req.user!.sub],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Paused subscription not found.');
    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

subscriptionsRouter.patch('/:id/read', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [row] = await query(
      `UPDATE business_subscriptions
       SET last_read_at = NOW(), updated_at = NOW()
       WHERE subscription_id = $1 AND user_id = $2 AND status IN ('active', 'paused')
       RETURNING subscription_id`,
      [req.params.id, req.user!.sub],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Subscription not found.');
    res.json({ ok: true, data: { read: true } });
  } catch (err) {
    next(err);
  }
});

const reportSchema = z.object({ reason: z.string().max(500).optional() });

subscriptionsRouter.post('/businesses/:businessId/report', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = reportSchema.parse(req.body ?? {});
    const biz = await queryOne(`SELECT business_id FROM businesses WHERE business_id = $1`, [req.params.businessId]);
    if (!biz) throw new AppError(404, 'NOT_FOUND', 'Business not found.');
    await query(
      `INSERT INTO business_reports (user_id, business_id, reason) VALUES ($1, $2, $3)`,
      [req.user!.sub, req.params.businessId, reason ?? null],
    );
    res.json({ ok: true, data: { reported: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

subscriptionsRouter.post('/businesses/:businessId/block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = reportSchema.parse(req.body ?? {});
    const userId = req.user!.sub;
    const biz = await queryOne(`SELECT business_id FROM businesses WHERE business_id = $1`, [req.params.businessId]);
    if (!biz) throw new AppError(404, 'NOT_FOUND', 'Business not found.');
    await query(
      `INSERT INTO business_blocks (user_id, business_id, reason) VALUES ($1, $2, $3)
       ON CONFLICT (user_id, business_id) DO NOTHING`,
      [userId, req.params.businessId, reason ?? null],
    );
    await query(
      `UPDATE business_subscriptions SET status = 'cancelled', cancelled_at = NOW(), updated_at = NOW()
        WHERE user_id = $1 AND business_id = $2 AND status IN ('active', 'paused', 'pending')`,
      [userId, req.params.businessId],
    );
    res.json({ ok: true, data: { blocked: true } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

subscriptionsRouter.delete('/businesses/:businessId/block', async (req: Request, res: Response, next: NextFunction) => {
  try {
    await query(`DELETE FROM business_blocks WHERE user_id = $1 AND business_id = $2`, [req.user!.sub, req.params.businessId]);
    res.json({ ok: true, data: { unblocked: true } });
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
