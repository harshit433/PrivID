import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, PLAN_LIMITS, generateApiKey } from '@trustroute/shared';
import { requireApiKey } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const meRouter = Router();
meRouter.use(requireApiKey);

meRouter.get('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const biz = req.business!;
    const row = await queryOne(
      `SELECT business_id, name, gstin, cin, category, contact_email, website, logo_url,
              status::text AS status, plan::text AS plan, verified_at, verified_handle,
              entity_kyc_ref, rejection_reason, created_at
       FROM businesses WHERE business_id = $1`,
      [biz.business_id],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Business not found.');

    const counts = await queryOne<{
      channel_count: string;
      subscriber_count: string;
      messages_today: string;
    }>(
      `SELECT
         (SELECT COUNT(*)::text FROM business_channels WHERE business_id = $1 AND active = TRUE) AS channel_count,
         (SELECT COUNT(*)::text FROM business_subscriptions
          WHERE business_id = $1 AND status = 'active') AS subscriber_count,
         (SELECT COUNT(*)::text FROM business_messages
          WHERE business_id = $1 AND created_at >= CURRENT_DATE) AS messages_today`,
      [biz.business_id],
    );

    const plan = biz.plan as keyof typeof PLAN_LIMITS;
    const limits = PLAN_LIMITS[plan] ?? PLAN_LIMITS.starter;

    res.json({
      ok: true,
      data: {
        ...row,
        usage: {
          channels: parseInt(counts?.channel_count ?? '0', 10),
          active_subscribers: parseInt(counts?.subscriber_count ?? '0', 10),
          messages_sent_today: parseInt(counts?.messages_today ?? '0', 10),
        },
        limits,
      },
    });
  } catch (err) {
    next(err);
  }
});

meRouter.get('/status', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await queryOne<{ status: string; rejection_reason: string | null; verified_at: Date | null }>(
      `SELECT status::text AS status, rejection_reason, verified_at
       FROM businesses WHERE business_id = $1`,
      [req.business!.business_id],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Business not found.');
    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

const patchSchema = z.object({
  name: z.string().min(2).max(200).optional(),
  logo_url: z.string().url().optional(),
  website: z.string().url().optional().or(z.literal('')),
  contact_email: z.string().email().optional(),
});

meRouter.patch('/', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = patchSchema.parse(req.body);
    const updates: string[] = [];
    const params: unknown[] = [];
    let i = 1;

    if (body.name !== undefined) { updates.push(`name = $${i++}`); params.push(body.name.trim()); }
    if (body.logo_url !== undefined) { updates.push(`logo_url = $${i++}`); params.push(body.logo_url); }
    if (body.website !== undefined) { updates.push(`website = $${i++}`); params.push(body.website || null); }
    if (body.contact_email !== undefined) {
      updates.push(`contact_email = $${i++}`);
      params.push(body.contact_email.trim().toLowerCase());
    }
    if (updates.length === 0) throw new AppError(400, 'NO_CHANGES', 'Nothing to update.');

    updates.push('updated_at = NOW()');
    params.push(req.business!.business_id);

    const [row] = await query(
      `UPDATE businesses SET ${updates.join(', ')} WHERE business_id = $${i}
       RETURNING business_id, name, logo_url, website, contact_email`,
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

/** Rotate API key — returns new key once (verified businesses only). */
meRouter.post('/api-key/rotate', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const biz = await queryOne<{ status: string }>(
      `SELECT status::text AS status FROM businesses WHERE business_id = $1`,
      [req.business!.business_id],
    );
    if (!biz || biz.status !== 'verified') {
      throw new AppError(403, 'NOT_VERIFIED', 'Only verified businesses can rotate API keys.');
    }

    const { rawKey, keyHash } = generateApiKey();
    await query(
      `UPDATE businesses SET api_key_hash = $1, updated_at = NOW() WHERE business_id = $2`,
      [keyHash, req.business!.business_id],
    );

    res.json({
      ok: true,
      data: {
        api_key: rawKey,
        message: 'Store this key securely. It will not be shown again.',
      },
    });
  } catch (err) {
    next(err);
  }
});
