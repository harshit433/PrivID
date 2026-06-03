import { Router, Request, Response, NextFunction } from 'express';
import { query, queryOne } from '@trustroute/shared';
import { requireApiKey } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const messagesRouter = Router();
messagesRouter.use(requireApiKey);

messagesRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const businessId = req.business!.business_id;
    const msg = await queryOne(
      `SELECT m.message_id, m.channel_id, m.business_id, m.content, m.template_id,
              m.total_subscribers, m.total_delivered, m.total_failed,
              m.status::text AS status, m.scheduled_at, m.sent_at, m.created_at,
              c.name AS channel_name
       FROM business_messages m
       JOIN business_channels c ON c.channel_id = m.channel_id
       WHERE m.message_id = $1 AND m.business_id = $2`,
      [req.params.id, businessId],
    );
    if (!msg) throw new AppError(404, 'NOT_FOUND', 'Message not found.');

    const deliveries = await query(
      `SELECT d.delivery_id, d.subscription_id, d.user_id, d.status::text AS status,
              d.error_message, d.delivered_at,
              u.handle, u.display_name
       FROM business_message_deliveries d
       JOIN users u ON u.user_id = d.user_id
       WHERE d.message_id = $1
       ORDER BY d.created_at ASC
       LIMIT 500`,
      [req.params.id],
    );

    res.json({ ok: true, data: { ...msg, deliveries } });
  } catch (err) {
    next(err);
  }
});
