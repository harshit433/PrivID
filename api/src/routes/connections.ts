import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import type { ConnectionRow, UserRow } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { syncConnectionToStream } from '../services/stream';

export const connectionsRouter = Router();

// ─── GET /connections ─────────────────────────────────────────────────────────

connectionsRouter.get('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const typeFilter = req.query.type as string | undefined;

    const rows = await query(
      `SELECT
         c.connection_id,
         c.connection_type,
         c.temporary_expires_at,
         c.daily_call_limit,
         c.created_at,
         u.user_id,
         u.handle,
         COALESCE(NULLIF(TRIM(c.contact_name), ''), u.display_name) AS display_name,
         u.avatar_url,
         u.trust_tier,
         u.trust_score,
         COALESCE(r.connection_type, 'unknown') AS reverse_connection_type,
         r.daily_call_limit AS reverse_daily_call_limit,
         r.temporary_expires_at AS reverse_temporary_expires_at
       FROM connections c
       JOIN users u ON u.user_id = c.contact_id
       LEFT JOIN connections r ON r.owner_id = c.contact_id AND r.contact_id = c.owner_id
       WHERE c.owner_id = $1
         ${typeFilter ? 'AND c.connection_type = $2' : ''}
       ORDER BY COALESCE(NULLIF(TRIM(c.contact_name), ''), u.display_name) ASC`,
      typeFilter ? [req.user!.sub, typeFilter] : [req.user!.sub]
    );

    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

// ─── POST /connections ────────────────────────────────────────────────────────

const addSchema = z.object({
  contact_id: z.string().uuid(),
  connection_type: z.enum(['unknown', 'temporary', 'trusted', 'blocked']).default('trusted'),
  contact_name: z.string().min(1).max(60).optional(),
  temporary_expires_at: z.string().datetime().optional(),
  daily_call_limit: z.number().int().min(1).max(50).optional(),
});

connectionsRouter.post('/', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = addSchema.parse(req.body);

    if (body.contact_id === req.user!.sub) {
      throw new AppError(400, 'SELF_CONNECTION', 'Cannot add yourself as a contact.');
    }

    const contact = await queryOne<UserRow>(`SELECT user_id FROM users WHERE user_id = $1`, [body.contact_id]);
    if (!contact) throw new AppError(404, 'USER_NOT_FOUND', 'Contact not found.');

    const contactName = body.contact_name?.trim() || null;

    const [conn] = await query<ConnectionRow>(
      `INSERT INTO connections (owner_id, contact_id, connection_type, contact_name, temporary_expires_at, daily_call_limit)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (owner_id, contact_id) DO UPDATE
         SET connection_type = EXCLUDED.connection_type,
             contact_name = COALESCE(EXCLUDED.contact_name, connections.contact_name),
             temporary_expires_at = EXCLUDED.temporary_expires_at,
             daily_call_limit = EXCLUDED.daily_call_limit
       RETURNING *`,
      [
        req.user!.sub,
        body.contact_id,
        body.connection_type,
        contactName,
        body.temporary_expires_at ?? null,
        body.daily_call_limit ?? null,
      ]
    );

    // Mirror the relationship into chat: block bans, any other type unbans.
    syncConnectionToStream(req.user!.sub, body.contact_id, body.connection_type).catch(() => {});

    res.status(201).json({ ok: true, data: conn });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── PATCH /connections/:id/permission ───────────────────────────────────────

const updateSchema = z.object({
  connection_type: z.enum(['unknown', 'temporary', 'trusted', 'blocked']),
  temporary_expires_at: z.string().datetime().optional(),
  daily_call_limit: z.number().int().min(1).max(50).optional(),
});

connectionsRouter.patch('/:id/permission', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = updateSchema.parse(req.body);

    const existing = await queryOne<ConnectionRow>(
      `SELECT * FROM connections WHERE connection_id = $1 AND owner_id = $2`,
      [req.params.id, req.user!.sub]
    );
    if (!existing) throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Connection not found.');

    const [updated] = await query<ConnectionRow>(
      `UPDATE connections
       SET connection_type = $1,
           temporary_expires_at = $2,
           daily_call_limit = $3
       WHERE connection_id = $4
       RETURNING *`,
      [body.connection_type, body.temporary_expires_at ?? null, body.daily_call_limit ?? null, req.params.id]
    );

    // Mirror the relationship into chat: block bans, any other type unbans.
    syncConnectionToStream(existing.owner_id, existing.contact_id, body.connection_type).catch(() => {});

    res.json({ ok: true, data: updated });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── DELETE /connections/:id ──────────────────────────────────────────────────

connectionsRouter.delete('/:id', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const result = await query(
      `DELETE FROM connections WHERE connection_id = $1 AND owner_id = $2 RETURNING connection_id`,
      [req.params.id, req.user!.sub]
    );
    if (result.length === 0) throw new AppError(404, 'CONNECTION_NOT_FOUND', 'Connection not found.');
    res.json({ ok: true, data: null });
  } catch (err) {
    next(err);
  }
});
