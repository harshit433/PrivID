/**
 * api/src/routes/numbers.ts
 *
 * Shadow Trust endpoints — crowd-sourced reputation for phone numbers that
 * are not yet on TrustRoute.
 *
 * Routes:
 *   POST /numbers/observe         — batch-submit dialer observations (mobile app)
 *   POST /numbers/shadow          — query shadow scores for a list of phone hashes
 *   GET  /numbers/shadow/:hash    — single hash lookup (callee incoming-call screen)
 *
 * Design notes:
 *   • The mobile app hashes phone numbers (SHA-256) BEFORE sending.
 *     Raw phone numbers never reach the server.
 *   • Observations are deduplicated per (observer, hash, hour) via a unique index.
 *   • shadow_numbers rows are written by the worker nightly; this file only
 *     reads them and writes raw dialer_observations.
 *   • Queries are intentionally anonymous from the callee's perspective:
 *     the response reveals a score + warning label but never *who* submitted it.
 */

import { Router, Request, Response, NextFunction } from 'express';
import crypto from 'crypto';
import { z } from 'zod';
import { query, queryOne } from '@trustroute/shared';
import type { ShadowNumberRow, DialerOutcome } from '@trustroute/shared';
import { requireAuth } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { logger } from '../utils/logger';

export const numbersRouter = Router();

// ─── Helpers ──────────────────────────────────────────────────────────────────

const OBSERVATION_WINDOW_DAYS = 180;  // only recent observations count toward score

/**
 * Convert a shadow_score to a human-readable warning level.
 *   0–25   SPAM      — likely spam / scam
 *  26–40   SUSPICIOUS — many users declined or blocked
 *  41–59   UNKNOWN   — insufficient data
 *  60–79   NEUTRAL   — mostly neutral interactions
 *  80–100  TRUSTED   — many users picked up or saved
 */
function scoreToLabel(score: number, observationCount: number): string {
  if (observationCount < 5) return 'UNKNOWN';
  if (score <= 25) return 'SPAM';
  if (score <= 40) return 'SUSPICIOUS';
  if (score <= 59) return 'UNKNOWN';
  if (score <= 79) return 'NEUTRAL';
  return 'TRUSTED';
}

// ─── POST /numbers/observe ────────────────────────────────────────────────────
//
// The mobile app calls this in the background after the user's regular dialer
// shows a call result. The user must have opted in to shadow trust participation.
//
// Accepts up to 50 observations per call (batched for network efficiency).
// Each observation: phone_hash (SHA-256 hex, 64 chars) + outcome + optional duration.

const observeItemSchema = z.object({
  phone_hash:  z.string().length(64).regex(/^[0-9a-f]+$/i, 'Must be a hex SHA-256 hash'),
  outcome:     z.enum(['picked_up', 'declined', 'blocked', 'saved', 'hung_up_fast']),
  duration_s:  z.number().int().min(0).max(86_400).optional(),
  observed_at: z.string().datetime().optional(), // client-side timestamp; fallback to NOW()
});

const observeSchema = z.object({
  observations: z.array(observeItemSchema).min(1).max(50),
});

numbersRouter.post('/observe', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { observations } = observeSchema.parse(req.body);
    const observerId = req.user!.sub;

    // Insert all observations in a single query — the unique index on
    // (observer_id, phone_hash, date_trunc('hour', observed_at)) silently
    // deduplicates concurrent or replayed submissions.
    const values: unknown[] = [];
    const placeholders: string[] = [];

    observations.forEach((obs, i) => {
      const base = i * 5;
      placeholders.push(`($${base + 1}, $${base + 2}, $${base + 3}, $${base + 4}, $${base + 5})`);
      values.push(
        observerId,
        obs.phone_hash.toLowerCase(),
        obs.outcome,
        obs.duration_s ?? null,
        obs.observed_at ? new Date(obs.observed_at) : new Date(),
      );
    });

    const inserted = await query(
      `INSERT INTO dialer_observations (observer_id, phone_hash, outcome, duration_s, observed_at)
       VALUES ${placeholders.join(', ')}
       ON CONFLICT (observer_id, phone_hash, date_trunc('hour', observed_at)) DO NOTHING
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

// ─── POST /numbers/shadow ─────────────────────────────────────────────────────
//
// Bulk lookup: given a list of phone hashes, return shadow scores + warning labels.
// Used by the app to enrich an incoming call screen before the user picks up,
// or to annotate a call log with reputation information.
//
// Accepts up to 100 hashes per request.

const shadowQuerySchema = z.object({
  hashes: z.array(z.string().length(64).regex(/^[0-9a-f]+$/i)).min(1).max(100),
});

numbersRouter.post('/shadow', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { hashes } = shadowQuerySchema.parse(req.body);

    const rows = await query<Pick<ShadowNumberRow,
      'phone_hash' | 'shadow_score' | 'block_rate' | 'observation_count'>>(
      `SELECT phone_hash, shadow_score, block_rate, observation_count
         FROM shadow_numbers
        WHERE phone_hash = ANY($1)`,
      [hashes.map((h) => h.toLowerCase())],
    );

    // Build a map of found hashes
    const found = new Map(rows.map((r) => [r.phone_hash, r]));

    const results = hashes.map((hash) => {
      const lower = hash.toLowerCase();
      const row   = found.get(lower);
      return {
        phone_hash:        lower,
        shadow_score:      row?.shadow_score      ?? 50,
        block_rate:        row?.block_rate        ?? 0,
        observation_count: row?.observation_count ?? 0,
        label:             scoreToLabel(
          row?.shadow_score      ?? 50,
          row?.observation_count ?? 0,
        ),
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
//
// Single-hash lookup — used on the incoming call screen (one number at a time).
// Also returns the human-readable "decline count" for display:
//   "847 TrustRoute users declined this number"

numbersRouter.get('/shadow/:hash', requireAuth, async (req: Request, res: Response, next: NextFunction) => {
  try {
    const hash = req.params.hash?.toLowerCase();
    if (!hash || !/^[0-9a-f]{64}$/.test(hash)) {
      throw new AppError(400, 'INVALID_HASH', 'Must be a 64-char lowercase hex SHA-256 hash.');
    }

    const row = await queryOne<ShadowNumberRow>(
      `SELECT phone_hash, shadow_score, pick_rate, declined_rate,
              block_rate, save_rate, observation_count
         FROM shadow_numbers
        WHERE phone_hash = $1`,
      [hash],
    );

    if (!row) {
      return res.json({
        ok: true,
        data: {
          phone_hash:        hash,
          shadow_score:      50,
          observation_count: 0,
          label:             'UNKNOWN',
          warning:           null,
        },
      });
    }

    // Compute approximate decline count for UI copy ("847 users declined this")
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
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Utility: compute phone_hash (used by auth.ts on registration) ────────────

export function hashPhone(phoneE164: string): string {
  return crypto.createHash('sha256').update(phoneE164.trim()).digest('hex');
}
