import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, PLAN_LIMITS } from '@trustroute/shared';
import { requireApiKey } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { enqueueBusinessMessageDelivery } from '../services/queue';

export const channelsRouter = Router();
channelsRouter.use(requireApiKey);

async function getChannelForBusiness(channelId: string, businessId: string) {
  return queryOne<{
    channel_id: string;
    business_id: string;
    name: string;
    channel_type: string;
    daily_limit_per_subscriber: number;
    active: boolean;
    created_at: Date;
  }>(
    `SELECT channel_id, business_id, name, channel_type::text AS channel_type,
            daily_limit_per_subscriber, active, created_at
     FROM business_channels WHERE channel_id = $1 AND business_id = $2`,
    [channelId, businessId],
  );
}

async function assertPlanAllowsChannels(businessId: string, plan: keyof typeof PLAN_LIMITS) {
  const [row] = await query<{ n: string }>(
    `SELECT COUNT(*)::text AS n FROM business_channels WHERE business_id = $1`,
    [businessId],
  );
  const count = parseInt(row?.n ?? '0', 10);
  const max = PLAN_LIMITS[plan]?.maxChannels ?? PLAN_LIMITS.starter.maxChannels;
  if (count >= max) {
    throw new AppError(403, 'PLAN_LIMIT', `Channel limit reached for ${plan} plan (${max}).`);
  }
}

const createChannelSchema = z.object({
  name: z.string().min(1).max(120),
  channel_type: z.enum(['transactional', 'promotional', 'otp']).default('transactional'),
  daily_limit_per_subscriber: z.number().int().min(1).max(100).optional(),
});

channelsRouter.post('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createChannelSchema.parse(req.body);
    const biz = req.business!;
    await assertPlanAllowsChannels(biz.business_id, biz.plan);

    const [row] = await query(
      `INSERT INTO business_channels (business_id, name, channel_type, daily_limit_per_subscriber)
       VALUES ($1, $2, $3, $4)
       RETURNING channel_id, name, channel_type::text AS channel_type,
                 daily_limit_per_subscriber, active, created_at`,
      [
        biz.business_id,
        body.name.trim(),
        body.channel_type,
        body.daily_limit_per_subscriber ?? 10,
      ],
    );

    res.status(201).json({ ok: true, data: row });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

channelsRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query(
      `SELECT c.channel_id, c.name, c.channel_type::text AS channel_type,
              c.daily_limit_per_subscriber, c.active, c.created_at,
              COUNT(s.subscription_id) FILTER (WHERE s.status = 'active')::int AS subscriber_count
       FROM business_channels c
       LEFT JOIN business_subscriptions s ON s.channel_id = c.channel_id
       WHERE c.business_id = $1
       GROUP BY c.channel_id
       ORDER BY c.created_at ASC`,
      [req.business!.business_id],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

channelsRouter.get('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await getChannelForBusiness(req.params.id, req.business!.business_id);
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');

    const stats = await queryOne<{
      active_subscribers: string;
      pending_subscribers: string;
      messages_30d: string;
      delivered_30d: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM business_subscriptions
          WHERE channel_id = $1 AND status = 'active') AS active_subscribers,
         (SELECT COUNT(*)::text FROM business_subscriptions
          WHERE channel_id = $1 AND status = 'pending') AS pending_subscribers,
         (SELECT COUNT(*)::text FROM business_messages
          WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS messages_30d,
         (SELECT COALESCE(SUM(total_delivered), 0)::text FROM business_messages
          WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days') AS delivered_30d`,
      [channel.channel_id],
    );

    res.json({ ok: true, data: { ...channel, stats } });
  } catch (err) {
    next(err);
  }
});

const patchChannelSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  daily_limit_per_subscriber: z.number().int().min(1).max(100).optional(),
  active: z.boolean().optional(),
});

channelsRouter.patch('/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = patchChannelSchema.parse(req.body);
    const channel = await getChannelForBusiness(req.params.id, req.business!.business_id);
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');

    const updates: string[] = [];
    const params: unknown[] = [];
    let i = 1;
    if (body.name !== undefined) { updates.push(`name = $${i++}`); params.push(body.name.trim()); }
    if (body.daily_limit_per_subscriber !== undefined) {
      updates.push(`daily_limit_per_subscriber = $${i++}`);
      params.push(body.daily_limit_per_subscriber);
    }
    if (body.active !== undefined) { updates.push(`active = $${i++}`); params.push(body.active); }
    if (updates.length === 0) throw new AppError(400, 'NO_CHANGES', 'Nothing to update.');

    updates.push('updated_at = NOW()');
    params.push(channel.channel_id);

    const [row] = await query(
      `UPDATE business_channels SET ${updates.join(', ')} WHERE channel_id = $${i} RETURNING *`,
      params,
    );

    res.json({ ok: true, data: row });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

channelsRouter.get('/:id/analytics', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await getChannelForBusiness(req.params.id, req.business!.business_id);
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
      [channel.channel_id],
    );

    const daily = await query(
      `SELECT DATE(created_at) AS day,
              COUNT(*)::int AS messages,
              COALESCE(SUM(total_delivered), 0)::int AS delivered
       FROM business_messages
       WHERE channel_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       GROUP BY DATE(created_at)
       ORDER BY day ASC`,
      [channel.channel_id],
    );

    const delivered = parseInt(stats?.delivered_30d ?? '0', 10);
    const failed = parseInt(stats?.failed_30d ?? '0', 10);
    const attempts = delivered + failed;

    res.json({
      ok: true,
      data: {
        channel_id: channel.channel_id,
        channel_name: channel.name,
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

channelsRouter.get('/:id/subscribers', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await getChannelForBusiness(req.params.id, req.business!.business_id);
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');

    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const status = (req.query.status as string) || 'active';

    const rows = await query(
      `SELECT s.subscription_id, s.user_id, s.status::text AS status, s.subscribed_at,
              u.handle, u.display_name, u.avatar_url
       FROM business_subscriptions s
       JOIN users u ON u.user_id = s.user_id
       WHERE s.channel_id = $1 AND s.status = $2::business_subscription_status
       ORDER BY s.subscribed_at DESC NULLS LAST
       LIMIT $3 OFFSET $4`,
      [channel.channel_id, status, limit, offset],
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

const sendMessageSchema = z.object({
  content: z.string().min(1).max(4096),
  template_id: z.string().max(120).optional(),
  scheduled_at: z.string().datetime().optional(),
});

channelsRouter.post('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = sendMessageSchema.parse(req.body);
    const biz = req.business!;
    const channel = await getChannelForBusiness(req.params.id, biz.business_id);
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');
    if (!channel.active) throw new AppError(400, 'CHANNEL_INACTIVE', 'Channel is not active.');

    const plan = biz.plan as keyof typeof PLAN_LIMITS;
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter;

    const [today] = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM business_messages
       WHERE business_id = $1 AND created_at >= CURRENT_DATE`,
      [biz.business_id],
    );
    if (parseInt(today?.n ?? '0', 10) >= limits.maxMessagesPerDay) {
      throw new AppError(403, 'PLAN_LIMIT', 'Daily message limit reached for your plan.');
    }

    const [subCount] = await query<{ n: string }>(
      `SELECT COUNT(*)::text AS n FROM business_subscriptions
       WHERE channel_id = $1 AND status = 'active'`,
      [channel.channel_id],
    );
    const totalSubs = parseInt(subCount?.n ?? '0', 10);

    const scheduledAt = body.scheduled_at ? new Date(body.scheduled_at) : null;
    if (scheduledAt && scheduledAt.getTime() <= Date.now()) {
      throw new AppError(400, 'VALIDATION_ERROR', 'scheduled_at must be in the future.');
    }

    const [msg] = await query<{ message_id: string; status: string }>(
      `INSERT INTO business_messages
         (channel_id, business_id, content, template_id, total_subscribers, status, scheduled_at)
       VALUES ($1, $2, $3, $4, $5, 'queued', $6)
       RETURNING message_id, status::text AS status`,
      [
        channel.channel_id,
        biz.business_id,
        body.content.trim(),
        body.template_id ?? null,
        totalSubs,
        scheduledAt,
      ],
    );

    if (!scheduledAt) {
      await enqueueBusinessMessageDelivery(msg.message_id);
    }

    res.status(201).json({
      ok: true,
      data: {
        message_id: msg.message_id,
        status: msg.status,
        total_subscribers: totalSubs,
        delivery_enqueued: !scheduledAt,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

channelsRouter.get('/:id/messages', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await getChannelForBusiness(req.params.id, req.business!.business_id);
    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');

    const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? '20'), 10) || 20));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);

    const rows = await query(
      `SELECT message_id, content, template_id, total_subscribers, total_delivered,
              total_failed, status::text AS status, scheduled_at, sent_at, created_at
       FROM business_messages
       WHERE channel_id = $1
       ORDER BY created_at DESC
       LIMIT $2 OFFSET $3`,
      [channel.channel_id, limit, offset],
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});
