/**
 * api/src/routes/numbers.ts
 *
 * Shadow Trust — crowd-sourced reputation for SIM callers + TrustRoute lookup.
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne, getRedis, keys } from '@trustroute/shared';
import type { ShadowNumberRow, DialerOutcome } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';
import {
  computeObservationWeight,
  scoreToLabel,
  scoreToRingColor,
} from '../services/shadowTrust';

export const numbersRouter = Router();

const DIALER_OUTCOMES = [
  'picked_up', 'declined', 'blocked', 'saved', 'hung_up_fast',
  'incoming_accepted', 'incoming_declined', 'incoming_missed', 'incoming_blocked',
  'outgoing_answered', 'outgoing_missed', 'outgoing_declined',
] as const;

const observeItemSchema = z.object({
  phone_hash:         z.string().length(64).regex(/^[0-9a-f]+$/i),
  outcome:            z.enum(DIALER_OUTCOMES),
  direction:          z.enum(['incoming', 'outgoing']).optional(),
  duration_s:         z.number().int().min(0).max(86_400).optional(),
  observed_at:        z.string().datetime().optional(),
  is_contact:         z.boolean().optional(),
  is_trustroute_user: z.boolean().optional(),
  context_label:      z.string().max(80).optional(),
  connection_type:    z.string().max(32).optional(),
});

const observeSchema = z.object({
  observations: z.array(observeItemSchema).min(1).max(50),
});

// ─── POST /numbers/observe ────────────────────────────────────────────────────

numbersRouter.post('/observe', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { observations } = observeSchema.parse(req.body);
    const observerId = req.user!.sub;

    const enabled = await queryOne<{ shadow_trust_enabled: boolean }>(
      `SELECT shadow_trust_enabled FROM users WHERE user_id = $1`,
      [observerId],
    );
    if (!enabled?.shadow_trust_enabled) {
      throw new AppError(403, 'SHADOW_TRUST_DISABLED', 'Shadow Trust is not enabled for this account.');
    }

    const values: unknown[] = [];
    const placeholders: string[] = [];

    let rowIndex = 0;
    for (const obs of observations) {
      const weight = computeObservationWeight(
        obs.outcome as DialerOutcome,
        obs.is_contact ?? false,
        obs.is_trustroute_user ?? false,
        obs.connection_type,
      );
      if (weight <= 0) continue;

      const base = rowIndex * 10;
      placeholders.push(
        `($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5}, $${base + 6}, $${base + 7}, $${base + 8}, $${base + 9}, $${base + 10})`,
      );
      values.push(
        observerId,
        obs.phone_hash.toLowerCase(),
        obs.outcome,
        obs.direction ?? null,
        obs.is_contact ?? false,
        obs.is_trustroute_user ?? false,
        obs.context_label ?? null,
        weight,
        obs.duration_s ?? null,
        obs.observed_at ? new Date(obs.observed_at) : new Date(),
      );
      rowIndex += 1;
    }

    if (placeholders.length === 0) {
      return res.json({ ok: true, data: { submitted: observations.length, accepted: 0, skipped: observations.length } });
    }

    const inserted = await query(
      `INSERT INTO dialer_observations
         (observer_id, phone_hash, outcome, direction, is_contact, is_trustroute_user,
          context_label, weight, duration_s, observed_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (observer_id, phone_hash, (date_trunc('hour', observed_at AT TIME ZONE 'UTC'))) DO NOTHING
       RETURNING obs_id`,
      values,
    );

    logger.debug('numbers/observe', 'Observations stored', {
      observer: observerId,
      submitted: observations.length,
      accepted: inserted.length,
    });

    res.json({
      ok: true,
      data: {
        submitted: observations.length,
        accepted:  inserted.length,
        skipped:   observations.length - inserted.length,
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

// ─── POST /numbers/caller-info ────────────────────────────────────────────────
//
// Unified lookup for SIM incoming-call overlay: TrustRoute user OR shadow score.

const callerInfoSchema = z.object({
  phone_hash: z.string().length(64).regex(/^[0-9a-f]+$/i),
  is_contact: z.boolean().optional(),
});

numbersRouter.post('/caller-info', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { phone_hash, is_contact } = callerInfoSchema.parse(req.body);
    const hash = phone_hash.toLowerCase();
    const viewerId = req.user!.sub;

    const cacheKey = keys.shadowCaller(hash);
    try {
      const cached = await getRedis().get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        if (is_contact && parsed.subtitle && !parsed.subtitle.includes('contact')) {
          parsed.subtitle = `In your contacts · ${parsed.subtitle}`;
        }
        return res.json({ ok: true, data: parsed });
      }
    } catch {
      // cache miss / redis down — continue
    }

    const trustRouteUser = await queryOne<{
      user_id: string;
      handle: string;
      display_name: string;
      trust_tier: string;
      trust_score: number;
    }>(
      `SELECT u.user_id, u.handle, u.display_name, u.trust_tier, u.trust_score
         FROM users u
        WHERE u.phone_hash = $1 AND u.is_active = TRUE AND u.user_id != $2`,
      [hash, viewerId],
    );

    if (trustRouteUser) {
      const conn = await queryOne<{ connection_type: string; contact_name: string | null }>(
        `SELECT connection_type, contact_name
           FROM connections
          WHERE owner_id = $1 AND contact_id = $2`,
        [viewerId, trustRouteUser.user_id],
      );

      const connectionType = conn?.connection_type ?? 'unknown';
      let subtitle = `${trustRouteUser.display_name} on TrustRoute`;
      if (connectionType === 'trusted') subtitle = 'Trusted contact on TrustRoute';
      else if (connectionType === 'blocked') subtitle = 'Blocked on TrustRoute';
      else if (is_contact) subtitle = 'In your contacts · on TrustRoute';

      const payload = {
        source: 'trustroute' as const,
        phone_hash: hash,
        trust_score: trustRouteUser.trust_score,
        trust_tier: trustRouteUser.trust_tier,
        handle: trustRouteUser.handle,
        display_name: trustRouteUser.display_name,
        connection_type: connectionType,
        shadow_score: null,
        label: 'TRUSTROUTE',
        warning: null as string | null,
        ring_color: scoreToRingColor(trustRouteUser.trust_score, 5, 'trustroute'),
        subtitle,
        score_display: trustRouteUser.trust_score,
      };

      try {
        await getRedis().setex(cacheKey, 600, JSON.stringify(payload));
      } catch { /* ignore */ }

      return res.json({ ok: true, data: payload });
    }

    const shadow = await queryOne<ShadowNumberRow>(
      `SELECT phone_hash, shadow_score, declined_rate, block_rate, observation_count
         FROM shadow_numbers WHERE phone_hash = $1`,
      [hash],
    );

    const shadowScore = shadow?.shadow_score ?? 50;
    const obsCount = shadow?.observation_count ?? 0;
    const label = scoreToLabel(shadowScore, obsCount);

    const declineCount = shadow && shadow.observation_count > 0
      ? Math.round(shadow.declined_rate * shadow.observation_count)
      : 0;
    const blockCount = shadow && shadow.observation_count > 0
      ? Math.round(shadow.block_rate * shadow.observation_count)
      : 0;

    let warning: string | null = null;
    if (label === 'SPAM' && blockCount > 0) {
      warning = `${blockCount} TrustRoute users blocked this number`;
    } else if (label === 'SUSPICIOUS' && declineCount > 0) {
      warning = `${declineCount} TrustRoute users declined this number`;
    }

    let subtitle = 'Not on TrustRoute';
    if (is_contact) subtitle = 'In your contacts · not on TrustRoute';
    if (label === 'UNKNOWN' && obsCount < 5) subtitle = 'No TrustRoute history yet';

    const payload = {
      source: 'shadow' as const,
      phone_hash: hash,
      trust_score: null,
      trust_tier: null,
      handle: null,
      display_name: null,
      connection_type: null,
      shadow_score: shadowScore,
      label,
      warning,
      ring_color: scoreToRingColor(shadowScore, obsCount, 'shadow'),
      subtitle,
      score_display: obsCount >= 5 ? shadowScore : null,
    };

    try {
      await getRedis().setex(cacheKey, 600, JSON.stringify(payload));
    } catch { /* ignore */ }

    res.json({ ok: true, data: payload });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

// ─── POST /numbers/shadow ─────────────────────────────────────────────────────

const shadowQuerySchema = z.object({
  hashes: z.array(z.string().length(64).regex(/^[0-9a-f]+$/i)).min(1).max(100),
});

numbersRouter.post('/shadow', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { hashes } = shadowQuerySchema.parse(req.body);

    const rows = await query<Pick<ShadowNumberRow,
      'phone_hash' | 'shadow_score' | 'block_rate' | 'observation_count'>>(
      `SELECT phone_hash, shadow_score, block_rate, observation_count
         FROM shadow_numbers WHERE phone_hash = ANY($1)`,
      [hashes.map((h) => h.toLowerCase())],
    );

    const found = new Map(rows.map((r) => [r.phone_hash, r]));

    const results = hashes.map((hash) => {
      const lower = hash.toLowerCase();
      const row = found.get(lower);
      return {
        phone_hash:        lower,
        shadow_score:      row?.shadow_score      ?? 50,
        block_rate:        row?.block_rate        ?? 0,
        observation_count: row?.observation_count ?? 0,
        label:             scoreToLabel(row?.shadow_score ?? 50, row?.observation_count ?? 0),
      };
    });

    res.json({ ok: true, data: results });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

// ─── GET /numbers/shadow/:hash ────────────────────────────────────────────────

numbersRouter.get('/shadow/:hash', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hash = req.params.hash?.toLowerCase();
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new AppError(400, 'INVALID_HASH', 'Must be a 64-char lowercase hex SHA-256 hash.');
    }

    const row = await queryOne<ShadowNumberRow>(
      `SELECT phone_hash, shadow_score, pick_rate, declined_rate,
              block_rate, save_rate, observation_count
         FROM shadow_numbers WHERE phone_hash = $1`,
      [hash],
    );

    if (!row) {
      return res.json({
        ok: true,
        data: {
          phone_hash: hash,
          shadow_score: 50,
          observation_count: 0,
          label: 'UNKNOWN',
          warning: null,
          ring_color: scoreToRingColor(50, 0, 'shadow'),
        },
      });
    }

    const declineCount = row.observation_count > 0
      ? Math.round(row.declined_rate * row.observation_count)
      : 0;
    const blockCount = row.observation_count > 0
      ? Math.round(row.block_rate * row.observation_count)
      : 0;

    const label = scoreToLabel(row.shadow_score, row.observation_count);

    let warning: string | null = null;
    if (label === 'SPAM' && blockCount > 0) {
      warning = `${blockCount} TrustRoute ${blockCount === 1 ? 'user' : 'users'} blocked this number`;
    } else if (label === 'SUSPICIOUS' && declineCount > 0) {
      warning = `${declineCount} TrustRoute ${declineCount === 1 ? 'user' : 'users'} declined this number`;
    }

    res.json({
      ok: true,
      data: {
        phone_hash:        row.phone_hash,
        shadow_score:      row.shadow_score,
        observation_count: row.observation_count,
        label,
        warning,
        ring_color: scoreToRingColor(row.shadow_score, row.observation_count, 'shadow'),
      },
    });
  } catch (err) {
    next(err);
  }
});

export function hashPhone(phoneE164: string): string {
  return crypto.createHash('sha256').update(phoneE164.trim()).digest('hex');
}
