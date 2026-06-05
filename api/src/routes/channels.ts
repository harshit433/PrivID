import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import type { ReachabilityChannelRow, ReachabilityChannelPublic } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';

export const channelsRouter = Router();

// ─── GET /channels ────────────────────────────────────────────────────────────

channelsRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const rows = await query<ReachabilityChannelRow>(
      `SELECT channel_id, token, label, status, daily_limit, total_limit, use_count, expires_at, created_at
       FROM reachability_channels
       WHERE owner_id = $1
       ORDER BY created_at DESC`,
      [req.user!.sub]
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST /channels ───────────────────────────────────────────────────────────

const createSchema = z.object({
  label: z.string().min(1).max(60).optional(),
  daily_limit: z.number().int().min(1).max(20).default(3),
  total_limit: z.number().int().min(1).optional(),
  expires_at: z.string().datetime().optional(),
});

channelsRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = createSchema.parse(req.body);

    const [channel] = await query<ReachabilityChannelRow>(
      `INSERT INTO reachability_channels (owner_id, label, daily_limit, total_limit, expires_at)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user!.sub, body.label ?? null, body.daily_limit, body.total_limit ?? null, body.expires_at ?? null]
    );

    res.status(201).json({ ok: true, data: channel });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /channels/resolve/:token ─────────────────────────────────────────────
// Public endpoint — no auth required, used by callers with a shared link

channelsRouter.get('/resolve/:token', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const channel = await queryOne<ReachabilityChannelRow>(
      `SELECT rc.channel_id, rc.status, rc.daily_limit, rc.total_limit, rc.use_count, rc.expires_at,
              u.handle, u.display_name, u.trust_tier
       FROM reachability_channels rc
       JOIN users u ON u.user_id = rc.owner_id
       WHERE rc.token = $1`,
      [req.params.token]
    ) as ReachabilityChannelPublic | null;

    if (!channel) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Reachability link not found.');
    if (channel.status !== 'active') throw new AppError(410, 'CHANNEL_INACTIVE', 'This link is no longer active.');
    if (channel.expires_at && new Date() > channel.expires_at) {
      throw new AppError(410, 'CHANNEL_EXPIRED', 'This link has expired.');
    }

    // Don't expose total_limit / use_count to public
    res.json({
      ok: true,
      data: {
        channel_id: channel.channel_id,
        handle: channel.handle,
        display_name: channel.display_name,
        trust_tier: channel.trust_tier,
        can_call: channel.status === 'active',
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── PATCH /channels/:id ──────────────────────────────────────────────────────

channelsRouter.patch('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = z.object({
      label: z.string().min(1).max(60).optional(),
      daily_limit: z.number().int().min(1).max(20).optional(),
      status: z.enum(['active', 'revoked']).optional(),
    }).parse(req.body);

    const existing = await queryOne(
      `SELECT channel_id FROM reachability_channels WHERE channel_id = $1 AND owner_id = $2`,
      [req.params.id, req.user!.sub]
    );
    if (!existing) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');

    const updates: string[] = [];
    const params: any[] = [];
    let i = 1;

    if (body.label !== undefined) { updates.push(`label = $${i++}`); params.push(body.label); }
    if (body.daily_limit !== undefined) { updates.push(`daily_limit = $${i++}`); params.push(body.daily_limit); }
    if (body.status !== undefined) { updates.push(`status = $${i++}`); params.push(body.status); }

    if (updates.length === 0) throw new AppError(400, 'NO_CHANGES', 'Nothing to update.');

    params.push(req.params.id);
    params.push(req.user!.sub);
    const [updated] = await query(
      `UPDATE reachability_channels SET ${updates.join(', ')} WHERE channel_id = $${i} AND owner_id = $${i + 1} RETURNING *`,
      params
    );

    res.json({ ok: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── DELETE /channels/:id ─────────────────────────────────────────────────────

channelsRouter.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `UPDATE reachability_channels SET status = 'revoked' WHERE channel_id = $1 AND owner_id = $2 RETURNING channel_id`,
      [req.params.id, req.user!.sub]
    );
    if (result.length === 0) throw new AppError(404, 'CHANNEL_NOT_FOUND', 'Channel not found.');
    res.json({ ok: true, data: null });
  } catch (err) {
    next(err);
  }
});
