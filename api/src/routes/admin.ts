/**
 * api/src/routes/admin.ts  — v2
 *
 * Internal admin API for trust review resolution, ML feedback, and platform ops.
 *
 * All routes require x-admin-key (shared secret). This must be behind a VPN /
 * internal-only ingress in production — it is never exposed to end users.
 *
 * ┌──────────────────────────────────────────────────────────────────────┐
 * │  Review Resolution Actions                                           │
 * │                                                                      │
 * │  clear     — Account is fine. Remove review flag, optionally boost   │
 * │              score. Sends "all clear" push.                          │
 * │                                                                      │
 * │  warn      — First or minor offense. Remove flag, add -5 score       │
 * │              penalty, increment warning_count. Sends warning push.   │
 * │                                                                      │
 * │  restrict  — Moderate offense. Remove flag, set                      │
 * │              call_restriction_until (default 14 days), add -15       │
 * │              score penalty. Restricts outgoing calls to new          │
 * │              contacts. Sends restriction push.                       │
 * │                                                                      │
 * │  monitor   — Unclear case. Remove flag, set is_monitored = TRUE.     │
 * │              ML feedback job uses lower threshold for monitored      │
 * │              users. No push (silent).                                │
 * │                                                                      │
 * │  suspend   — Severe offense. Deactivate account. Sends suspension    │
 * │              push. Sends confirmed 'spammer' label to ML.            │
 * └──────────────────────────────────────────────────────────────────────┘
 *
 * Routes:
 *   GET  /admin/stats                  — platform-level counts
 *   GET  /admin/review/queue           — paginated queue with age + trigger
 *   GET  /admin/review/metrics         — SLA + resolution breakdown
 *   GET  /admin/review/:id             — full context for one user
 *   POST /admin/review/:id/resolve     — resolve with action
 *   POST /admin/review/bulk-resolve    — bulk clear/warn (up to 50)
 *   GET  /admin/review/:id/history     — action history for a user
 *   POST /admin/trust/override         — directly set trust score (emergency)
 *   POST /admin/ml/feedback            — submit confirmed label
 *   POST /admin/ml/retrain             — trigger retrain
 *   GET  /admin/ml/status              — ML service health
 */

import { Router, Request, Response, NextFunction } from 'express';
import { z } from 'zod';
import { query, queryOne, withTransaction, generateApiKey } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { requireAdmin } from '../middleware/auth';
import { AppError } from '../middleware/errorHandler';
import { mlSendFeedback, mlHealthCheck } from '../services/mlClient';
import { extractFeatures } from '../services/featureStore';
import { recomputeAndPersist } from '../services/trustScore';
import { sendAdminNotification } from '../services/fcm';
import { logger } from '../utils/logger';

export const adminRouter = Router();
adminRouter.use(requireAdmin);

// ─── Shared helpers ───────────────────────────────────────────────────────────

type ResolutionAction = 'clear' | 'warn' | 'restrict' | 'monitor' | 'suspend';

/** Fetch FCM token for a user; returns null if unavailable. */
async function getFcmToken(userId: string): Promise<string | null> {
  const row = await queryOne<{ fcm_token: string | null }>(
    `SELECT fcm_token FROM users WHERE user_id = $1`,
    [userId],
  );
  return row?.fcm_token ?? null;
}

/** Log an admin action to the audit table. */
async function logAction(
  targetId: string,
  action:   ResolutionAction | string,
  note:     string | null | undefined,
  metadata: Record<string, unknown> = {},
  adminRef?: string,
): Promise<string> {
  const [row] = await query<{ action_id: string }>(
    `INSERT INTO admin_actions (target_id, action, admin_ref, note, metadata)
     VALUES ($1, $2, $3, $4, $5)
     RETURNING action_id`,
    [targetId, action, adminRef ?? null, note ?? null, JSON.stringify(metadata)],
  );
  return row.action_id;
}

/** Apply a trust factor delta for admin-initiated penalties / bonuses. */
async function applyAdminTrustDelta(
  userId:     string,
  factorType: string,
  delta:      number,
  note:       string,
): Promise<void> {
  // Mark any existing is_latest entry for this type as stale
  await query(
    `UPDATE trust_factors SET is_latest = FALSE
      WHERE user_id = $1 AND factor_type = $2 AND is_latest = TRUE`,
    [userId, factorType],
  );
  await query(
    `INSERT INTO trust_factors
           (user_id, factor_type, status, score_delta, provider, metadata, verified_at, is_latest)
     VALUES ($1, $2, 'completed', $3, 'admin', $4, NOW(), TRUE)`,
    [userId, factorType, delta, JSON.stringify({ note })],
  );
  // Recompute score asynchronously (non-blocking)
  recomputeAndPersist(userId).catch(() => {});
}

// ─── GET /admin/stats ─────────────────────────────────────────────────────────

adminRouter.get('/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [users, calls, connections, reviews, shadowObs, recentActions] = await Promise.all([
      queryOne<{ total: string; verified: string; premium: string; under_review: string; suspended: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE is_active = TRUE)::text  AS total,
           COUNT(*) FILTER (WHERE is_active = TRUE AND trust_tier = 'verified')::text  AS verified,
           COUNT(*) FILTER (WHERE is_active = TRUE AND trust_tier = 'premium')::text   AS premium,
           COUNT(*) FILTER (WHERE is_active = TRUE AND is_under_review = TRUE)::text   AS under_review,
           COUNT(*) FILTER (WHERE is_active = FALSE)::text AS suspended
         FROM users`,
      ),
      queryOne<{ total: string; today: string; answered: string }>(
        `SELECT
           COUNT(*)::text AS total,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::text  AS today,
           COUNT(*) FILTER (WHERE status IN ('answered','ended'))::text           AS answered
         FROM calls`,
      ),
      queryOne<{ trusted: string; blocked: string; temporary: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE connection_type = 'trusted')::text   AS trusted,
           COUNT(*) FILTER (WHERE connection_type = 'blocked')::text   AS blocked,
           COUNT(*) FILTER (WHERE connection_type = 'temporary')::text AS temporary
         FROM connections`,
      ),
      queryOne<{ avg_age_hours: string; oldest_hours: string }>(
        `SELECT
           AVG(EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600)::text AS avg_age_hours,
           MAX(EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600)::text AS oldest_hours
         FROM users
         WHERE is_under_review = TRUE AND is_active = TRUE AND review_started_at IS NOT NULL`,
      ),
      queryOne<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM dialer_observations`,
      ),
      queryOne<{ clear: string; warn: string; restrict: string; suspend: string; monitor: string }>(
        `SELECT
           COUNT(*) FILTER (WHERE action = 'clear'    AND created_at > NOW() - INTERVAL '7 days')::text AS clear,
           COUNT(*) FILTER (WHERE action = 'warn'     AND created_at > NOW() - INTERVAL '7 days')::text AS warn,
           COUNT(*) FILTER (WHERE action = 'restrict' AND created_at > NOW() - INTERVAL '7 days')::text AS restrict,
           COUNT(*) FILTER (WHERE action = 'suspend'  AND created_at > NOW() - INTERVAL '7 days')::text AS suspend,
           COUNT(*) FILTER (WHERE action = 'monitor'  AND created_at > NOW() - INTERVAL '7 days')::text AS monitor
         FROM admin_actions`,
      ),
    ]);

    res.json({
      ok: true,
      data: {
        users: {
          total:        parseInt(users?.total        ?? '0'),
          verified:     parseInt(users?.verified     ?? '0'),
          premium:      parseInt(users?.premium      ?? '0'),
          under_review: parseInt(users?.under_review ?? '0'),
          suspended:    parseInt(users?.suspended    ?? '0'),
        },
        calls: {
          total:    parseInt(calls?.total    ?? '0'),
          today:    parseInt(calls?.today    ?? '0'),
          answered: parseInt(calls?.answered ?? '0'),
        },
        connections: {
          trusted:   parseInt(connections?.trusted   ?? '0'),
          blocked:   parseInt(connections?.blocked   ?? '0'),
          temporary: parseInt(connections?.temporary ?? '0'),
        },
        review_queue: {
          size:            parseInt(users?.under_review ?? '0'),
          avg_age_hours:   parseFloat(reviews?.avg_age_hours ?? '0'),
          oldest_hours:    parseFloat(reviews?.oldest_hours  ?? '0'),
        },
        shadow_observations: parseInt(shadowObs?.total ?? '0'),
        resolutions_7d: {
          clear:    parseInt(recentActions?.clear    ?? '0'),
          warn:     parseInt(recentActions?.warn     ?? '0'),
          restrict: parseInt(recentActions?.restrict ?? '0'),
          suspend:  parseInt(recentActions?.suspend  ?? '0'),
          monitor:  parseInt(recentActions?.monitor  ?? '0'),
        },
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/review/queue ──────────────────────────────────────────────────

adminRouter.get('/review/queue', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit  = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);
    const cursor = req.query.cursor as string | undefined; // ISO timestamp (review_started_at)

    const rows = await query<{
      user_id:           string;
      handle:            string;
      display_name:      string | null;
      trust_score:       number;
      trust_tier:        string;
      warning_count:     number;
      review_reason:     string | null;
      review_started_at: Date | null;
      queue_age_hours:   number;
      trigger_type:      string;
      is_monitored:      boolean;
    }>(
      `SELECT
         user_id, handle, display_name, trust_score, trust_tier,
         warning_count, review_reason, review_started_at, is_monitored,
         ROUND(EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600, 1) AS queue_age_hours,
         CASE
           WHEN review_reason ILIKE '%ML flagged%' OR review_reason ILIKE '%ML detected%'
             THEN 'ml_override'
           WHEN review_reason ILIKE '%Score dropped%' OR review_reason ILIKE '%abnormal%'
             THEN 'score_drop'
           ELSE 'manual'
         END AS trigger_type
       FROM users
       WHERE is_under_review = TRUE
         AND is_active = TRUE
         AND ($1::timestamptz IS NULL OR review_started_at < $1)
       ORDER BY review_started_at ASC NULLS LAST   -- oldest first (FIFO → best for SLA)
       LIMIT $2`,
      [cursor ? new Date(cursor) : null, limit + 1],
    );

    const hasMore  = rows.length > limit;
    const results  = hasMore ? rows.slice(0, limit) : rows;
    const lastItem = results[results.length - 1];

    res.json({
      ok: true,
      data: {
        results,
        next_cursor: hasMore && lastItem?.review_started_at
          ? lastItem.review_started_at.toISOString()
          : null,
        has_more: hasMore,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/review/metrics ────────────────────────────────────────────────

adminRouter.get('/review/metrics', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const [queueAge, resolutionCounts, avgTimeToResolve] = await Promise.all([
      // Queue age distribution
      query<{ bucket: string; count: string }>(
        `SELECT
           CASE
             WHEN EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600 < 4   THEN '< 4h'
             WHEN EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600 < 24  THEN '4–24h'
             WHEN EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600 < 72  THEN '1–3d'
             ELSE '3d+'
           END AS bucket,
           COUNT(*)::text AS count
         FROM users
         WHERE is_under_review = TRUE AND is_active = TRUE AND review_started_at IS NOT NULL
         GROUP BY 1
         ORDER BY 1`,
      ),
      // Resolution breakdown last 30 days
      query<{ action: string; count: string; last_24h: string }>(
        `SELECT
           action,
           COUNT(*)::text AS count,
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '1 day')::text AS last_24h
         FROM admin_actions
         WHERE action IN ('clear','warn','restrict','suspend','monitor')
           AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY action
         ORDER BY count DESC`,
      ),
      // Average time from flag to resolution (approximation from admin_actions + users)
      queryOne<{ avg_hours: string | null }>(
        `SELECT AVG(EXTRACT(EPOCH FROM (a.created_at - u.review_started_at)) / 3600)::text AS avg_hours
         FROM admin_actions a
         JOIN users u ON u.user_id = a.target_id
         WHERE a.action IN ('clear','warn','restrict','suspend','monitor')
           AND a.created_at > NOW() - INTERVAL '30 days'
           AND u.review_started_at IS NOT NULL`,
      ),
    ]);

    res.json({
      ok: true,
      data: {
        queue_age_distribution: queueAge,
        resolutions_30d:        resolutionCounts,
        avg_time_to_resolve_hours: avgTimeToResolve?.avg_hours
          ? parseFloat(avgTimeToResolve.avg_hours)
          : null,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/review/:id — Full user context ────────────────────────────────

adminRouter.get('/review/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;

    const [user, behaviorStats, callQuality, adminHistory, mlFeatures] = await Promise.all([
      // Full user profile
      queryOne<UserRow & {
        queue_age_hours: number | null;
        trigger_type: string;
      }>(
        `SELECT *,
           ROUND(EXTRACT(EPOCH FROM (NOW() - review_started_at)) / 3600, 1) AS queue_age_hours,
           CASE
             WHEN review_reason ILIKE '%ML flagged%' OR review_reason ILIKE '%ML detected%' THEN 'ml_override'
             WHEN review_reason ILIKE '%Score dropped%' THEN 'score_drop'
             ELSE 'manual'
           END AS trigger_type
         FROM users WHERE user_id = $1`,
        [id],
      ),

      // Behavioral stats for the review window
      queryOne<{
        blocks_7d:         string;
        blocks_30d:        string;
        calls_out_7d:      string;
        calls_out_30d:     string;
        unique_callees_7d: string;
        answer_rate_7d:    string | null;
        mass_flags_30d:    string;
        call_restriction_until: Date | null;
      }>(
        `SELECT
           (SELECT COUNT(*)::text FROM connections
            WHERE contact_id = $1 AND connection_type = 'blocked'
              AND updated_at > NOW() - INTERVAL '7 days')  AS blocks_7d,
           (SELECT COUNT(*)::text FROM connections
            WHERE contact_id = $1 AND connection_type = 'blocked'
              AND updated_at > NOW() - INTERVAL '30 days') AS blocks_30d,
           COUNT(*) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text  AS calls_out_7d,
           COUNT(*) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '30 days')::text AS calls_out_30d,
           COUNT(DISTINCT callee_id) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text AS unique_callees_7d,
           AVG((status IN ('answered','ended'))::int)
             FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text AS answer_rate_7d,
           (SELECT COUNT(*)::text FROM behavior_events
            WHERE user_id = $1 AND event_type = 'mass_outreach_flag'
              AND created_at > NOW() - INTERVAL '30 days') AS mass_flags_30d,
           u.call_restriction_until
         FROM calls, users u
         WHERE u.user_id = $1
           AND (caller_id = $1 OR callee_id = $1)
           AND calls.created_at > NOW() - INTERVAL '30 days'
         GROUP BY u.call_restriction_until`,
        [id],
      ),

      // Call quality summary
      queryOne<{ avg_mos: string | null; report_count: string }>(
        `SELECT AVG(mos_score)::text AS avg_mos, COUNT(*)::text AS report_count
         FROM call_quality_reports WHERE user_id = $1`,
        [id],
      ),

      // Admin action history for this user
      query<{ action_id: string; action: string; note: string | null; metadata: object; created_at: Date }>(
        `SELECT action_id, action, note, metadata, created_at
         FROM admin_actions WHERE target_id = $1
         ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),

      // Extract features for ML context (best-effort)
      extractFeatures(id).catch(() => null),
    ]);

    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    // Strip sensitive fields not needed for review (phone exposed to admin is acceptable)
    const { phone_hash: _, ...safeUser } = user as any;

    res.json({
      ok: true,
      data: {
        user: safeUser,
        behavior: {
          blocks_received_7d:  parseInt(behaviorStats?.blocks_7d    ?? '0'),
          blocks_received_30d: parseInt(behaviorStats?.blocks_30d   ?? '0'),
          outgoing_calls_7d:   parseInt(behaviorStats?.calls_out_7d ?? '0'),
          outgoing_calls_30d:  parseInt(behaviorStats?.calls_out_30d ?? '0'),
          unique_callees_7d:   parseInt(behaviorStats?.unique_callees_7d ?? '0'),
          answer_rate_7d:      behaviorStats?.answer_rate_7d
            ? parseFloat(behaviorStats.answer_rate_7d)
            : null,
          mass_outreach_flags_30d: parseInt(behaviorStats?.mass_flags_30d ?? '0'),
          currently_restricted:    !!(behaviorStats?.call_restriction_until
            && new Date(behaviorStats.call_restriction_until) > new Date()),
          restriction_expires:     behaviorStats?.call_restriction_until ?? null,
        },
        call_quality: {
          avg_mos_score: callQuality?.avg_mos ? parseFloat(callQuality.avg_mos) : null,
          report_count:  parseInt(callQuality?.report_count ?? '0'),
        },
        ml_features: mlFeatures
          ? {
              persona: mlFeatures.behavior_regime,
              score_slope_7d:   mlFeatures.score_slope_7d,
              burst_count_7d:   mlFeatures.burst_count_7d,
              block_trusted_ratio: mlFeatures.block_trusted_ratio,
              sequential_dialing_max: mlFeatures.sequential_dialing_max,
            }
          : null,
        admin_history: adminHistory,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /admin/review/:id/resolve ──────────────────────────────────────────

const resolveSchema = z.object({
  action: z.enum(['clear', 'warn', 'restrict', 'monitor', 'suspend']),
  note:   z.string().max(1000).optional(),
  // restrict-specific: how many days (default 14)
  restriction_days: z.number().int().min(1).max(180).optional(),
  // clear-specific: whether to refund the score drop that triggered review
  refund_score: z.boolean().optional(),
});

adminRouter.post('/review/:id/resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id }  = req.params;
    const body    = resolveSchema.parse(req.body);
    const adminRef = req.headers['x-admin-ref'] as string | undefined;

    const user = await queryOne<{
      user_id: string; handle: string; display_name: string | null;
      trust_score: number; trust_tier: string; fcm_token: string | null;
      is_under_review: boolean; is_active: boolean; warning_count: number;
    }>(
      `SELECT user_id, handle, display_name, trust_score, trust_tier,
              fcm_token, is_under_review, is_active, warning_count
         FROM users WHERE user_id = $1`,
      [id],
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');
    if (!user.is_active) throw new AppError(409, 'ACCOUNT_INACTIVE', 'Account is already suspended.');

    let pushBody: string | null = null;
    let actionMetadata: Record<string, unknown> = { note: body.note ?? null };

    await withTransaction(async (client) => {
      switch (body.action) {

        // ── clear ────────────────────────────────────────────────────────────
        case 'clear': {
          await client.query(
            `UPDATE users
                SET is_under_review   = FALSE,
                    review_reason     = NULL,
                    review_started_at = NULL
              WHERE user_id = $1`,
            [id],
          );

          if (body.refund_score) {
            // Refund up to 10 points so a false-positive review doesn't permanently
            // hurt a legitimate user's score.
            await client.query(
              `INSERT INTO trust_factors
                     (user_id, factor_type, status, score_delta, provider, metadata, verified_at, is_latest)
               VALUES ($1, 'admin_refund', 'completed', 7, 'admin', $2, NOW(), TRUE)
               ON CONFLICT DO NOTHING`,
              [id, JSON.stringify({ reason: 'review_cleared_refund', note: body.note })],
            );
            actionMetadata = { ...actionMetadata, refund_applied: true };
          }

          pushBody = 'Your account has been reviewed and is in good standing. Thank you for your patience.';
          break;
        }

        // ── warn ─────────────────────────────────────────────────────────────
        case 'warn': {
          await client.query(
            `UPDATE users
                SET is_under_review   = FALSE,
                    review_reason     = NULL,
                    review_started_at = NULL,
                    warning_count     = warning_count + 1
              WHERE user_id = $1`,
            [id],
          );
          // -5 score penalty per warning
          await client.query(
            `UPDATE trust_factors SET is_latest = FALSE
              WHERE user_id = $1 AND factor_type = 'admin_warning' AND is_latest = TRUE`,
            [id],
          );
          await client.query(
            `INSERT INTO trust_factors
                   (user_id, factor_type, status, score_delta, provider, metadata, verified_at, is_latest)
             VALUES ($1, 'admin_warning', 'completed', -5, 'admin', $2, NOW(), TRUE)`,
            [id, JSON.stringify({ note: body.note, warning_number: user.warning_count + 1 })],
          );
          actionMetadata = { ...actionMetadata, new_warning_count: user.warning_count + 1 };
          pushBody = `Your account received a warning regarding: ${body.note ?? 'community guideline violation'}. ` +
            'Continued violations may result in restrictions or suspension.';
          break;
        }

        // ── restrict ──────────────────────────────────────────────────────────
        case 'restrict': {
          const days = body.restriction_days ?? 14;
          const restrictUntil = new Date(Date.now() + days * 24 * 60 * 60 * 1000);

          await client.query(
            `UPDATE users
                SET is_under_review        = FALSE,
                    review_reason          = NULL,
                    review_started_at      = NULL,
                    call_restriction_until = $2
              WHERE user_id = $1`,
            [id, restrictUntil],
          );
          // -15 score penalty for restriction
          await client.query(
            `UPDATE trust_factors SET is_latest = FALSE
              WHERE user_id = $1 AND factor_type = 'admin_restriction' AND is_latest = TRUE`,
            [id],
          );
          await client.query(
            `INSERT INTO trust_factors
                   (user_id, factor_type, status, score_delta, provider, metadata, verified_at, is_latest)
             VALUES ($1, 'admin_restriction', 'completed', -15, 'admin', $2, NOW(), TRUE)`,
            [id, JSON.stringify({ days, expires: restrictUntil.toISOString(), note: body.note })],
          );
          actionMetadata = { ...actionMetadata, restriction_days: days, restriction_until: restrictUntil };
          pushBody = `Your account has been temporarily restricted for ${days} days due to ` +
            `${body.note ?? 'a policy violation'}. You can receive calls normally but ` +
            'outgoing calls to new contacts are limited. Restrictions will lift automatically.';
          break;
        }

        // ── monitor ───────────────────────────────────────────────────────────
        case 'monitor': {
          await client.query(
            `UPDATE users
                SET is_under_review   = FALSE,
                    review_reason     = NULL,
                    review_started_at = NULL,
                    is_monitored      = TRUE
              WHERE user_id = $1`,
            [id],
          );
          // No score penalty, no push — monitoring is silent
          actionMetadata = { ...actionMetadata, monitoring_started: new Date() };
          break;
        }

        // ── suspend ───────────────────────────────────────────────────────────
        case 'suspend': {
          await client.query(
            `UPDATE users
                SET is_active         = FALSE,
                    is_under_review   = FALSE,
                    review_reason     = $2,
                    review_started_at = NULL
              WHERE user_id = $1`,
            [id, body.note ? `Suspended: ${body.note}` : 'Account suspended.'],
          );
          await client.query(
            `INSERT INTO behavior_events (user_id, event_type, metadata)
             VALUES ($1, 'account_suspended', $2)`,
            [id, JSON.stringify({ reason: body.note ?? null, by: 'admin' })],
          );
          pushBody = `Your TrustRoute account has been suspended${body.note ? ` for: ${body.note}` : ''}. ` +
            'If you believe this is an error please contact support.';
          break;
        }
      }
    });

    // Log to audit table (outside transaction so it always persists)
    const actionId = await logAction(id, body.action, body.note, actionMetadata, adminRef);

    // Fire FCM notification (best-effort, after transaction committed)
    if (pushBody && user.fcm_token) {
      const typeMap: Record<string, any> = {
        clear: 'review_cleared', warn: 'warning',
        restrict: 'restriction', suspend: 'suspension',
      };
      sendAdminNotification(user.fcm_token, typeMap[body.action], pushBody).catch(() => {});
    }

    // For suspensions: auto-send ML feedback
    if (body.action === 'suspend') {
      extractFeatures(id)
        .then((f) => mlSendFeedback(id, 'spammer', 'suspicious', f))
        .catch(() => {});
    }

    // Trigger trust score recompute asynchronously (for warn/restrict/clear with refund)
    if (['warn', 'restrict', 'clear'].includes(body.action)) {
      recomputeAndPersist(id).catch(() => {});
    }

    logger.info('admin/review', 'Resolved', {
      user_id: id, handle: user.handle, action: body.action, action_id: actionId,
    });

    res.json({
      ok: true,
      data: { action_id: actionId, action: body.action, user_id: id },
    });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /admin/review/bulk-resolve ─────────────────────────────────────────
//
// Efficiently resolve multiple clear/obvious items at once.
// Only supports 'clear' and 'warn' to prevent accidental bulk suspensions.

const bulkResolveSchema = z.object({
  ids:    z.array(z.string().uuid()).min(1).max(50),
  action: z.enum(['clear', 'warn']),
  note:   z.string().max(500).optional(),
});

adminRouter.post('/review/bulk-resolve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { ids, action, note } = bulkResolveSchema.parse(req.body);
    const adminRef = req.headers['x-admin-ref'] as string | undefined;

    await withTransaction(async (client) => {
      if (action === 'clear') {
        await client.query(
          `UPDATE users
              SET is_under_review   = FALSE,
                  review_reason     = NULL,
                  review_started_at = NULL
            WHERE user_id = ANY($1) AND is_under_review = TRUE AND is_active = TRUE`,
          [ids],
        );
      } else {
        // warn: increment warning_count and clear review
        await client.query(
          `UPDATE users
              SET is_under_review   = FALSE,
                  review_reason     = NULL,
                  review_started_at = NULL,
                  warning_count     = warning_count + 1
            WHERE user_id = ANY($1) AND is_under_review = TRUE AND is_active = TRUE`,
          [ids],
        );
        // Insert warning factors for all affected users
        const warningValues = ids.flatMap((uid, i) => [uid, -5, JSON.stringify({ note: note ?? 'bulk_warn' })]);
        const warningPlaceholders = ids.map((_, i) => `($${i * 3 + 1}, 'admin_warning', 'completed', $${i * 3 + 2}, 'admin', $${i * 3 + 3}, NOW(), TRUE)`).join(', ');
        await client.query(
          `INSERT INTO trust_factors
                 (user_id, factor_type, status, score_delta, provider, metadata, verified_at, is_latest)
           VALUES ${warningPlaceholders}
           ON CONFLICT DO NOTHING`,
          warningValues,
        );
      }
    });

    // Log one bulk action record
    await logAction(
      ids[0],  // representative target (first id)
      `bulk_${action}`,
      note,
      { ids, count: ids.length },
      adminRef,
    );

    logger.info('admin/review', 'Bulk resolved', {
      action, count: ids.length, admin_ref: adminRef,
    });

    res.json({ ok: true, data: { action, count: ids.length } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── GET /admin/review/:id/history ───────────────────────────────────────────

adminRouter.get('/review/:id/history', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id } = req.params;
    const limit  = Math.min(parseInt(String(req.query.limit ?? '50'), 10), 200);

    const [actions, behaviorEvents] = await Promise.all([
      query<{ action_id: string; action: string; note: string | null; metadata: object; created_at: Date }>(
        `SELECT action_id, action, note, metadata, created_at
           FROM admin_actions
          WHERE target_id = $1
          ORDER BY created_at DESC
          LIMIT $2`,
        [id, limit],
      ),
      query<{ event_type: string; metadata: object; created_at: Date }>(
        `SELECT event_type, metadata, created_at
           FROM behavior_events
          WHERE user_id = $1
            AND event_type IN (
              'mass_outreach_flag','account_suspended','review_cleared',
              'ml_feedback_submitted','ml_feedback_auto_sent','account_suspension'
            )
          ORDER BY created_at DESC
          LIMIT 30`,
        [id],
      ),
      // Also fetch trust_factors for audit trail
    ]);

    const trustFactors = await query<{
      factor_type: string; status: string; score_delta: number;
      provider: string; verified_at: Date | null; metadata: object;
    }>(
      `SELECT factor_type, status, score_delta, provider, verified_at, metadata
         FROM trust_factors
        WHERE user_id = $1
          AND factor_type LIKE 'admin_%'
        ORDER BY created_at DESC NULLS LAST
        LIMIT 30`,
      [id],
    );

    res.json({
      ok: true,
      data: {
        admin_actions:   actions,
        behavior_events: behaviorEvents,
        trust_factors:   trustFactors,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── POST /admin/trust/override ───────────────────────────────────────────────
//
// Emergency: directly set trust score. Use when ML produced a clearly wrong score
// and a recompute won't fix it (e.g., during a model incident).

const overrideSchema = z.object({
  score: z.number().int().min(0).max(100),
  note:  z.string().min(1).max(500),
});

adminRouter.post('/trust/override', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { id }   = req.query as { id: string };
    const { score, note } = overrideSchema.parse(req.body);
    const adminRef = req.headers['x-admin-ref'] as string | undefined;

    if (!id) throw new AppError(400, 'MISSING_ID', 'Provide user_id as query param ?id=');

    const user = await queryOne<{ user_id: string; trust_score: number; trust_tier: string }>(
      `SELECT user_id, trust_score, trust_tier FROM users WHERE user_id = $1`,
      [id],
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    // Insert an admin_override trust factor that will be picked up by recompute
    await applyAdminTrustDelta(id, 'admin_override', score - user.trust_score, note);

    await logAction(id, 'trust_override', note, {
      old_score: user.trust_score,
      new_target: score,
      delta: score - user.trust_score,
    }, adminRef);

    logger.warn('admin/trust', 'Score overridden', {
      user_id: id, old: user.trust_score, new: score, note,
    });

    res.json({ ok: true, data: { user_id: id, old_score: user.trust_score, target_score: score } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /admin/ml/feedback ──────────────────────────────────────────────────

const feedbackSchema = z.object({
  user_id:    z.string().uuid(),
  true_label: z.enum(['normal', 'spammer', 'harasser', 'robocall', 'scammer']),
  note:       z.string().max(500).optional(),
});

adminRouter.post('/ml/feedback', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { user_id, true_label, note } = feedbackSchema.parse(req.body);
    const adminRef = req.headers['x-admin-ref'] as string | undefined;

    const user = await queryOne<Pick<UserRow, 'user_id' | 'trust_score' | 'trust_tier'>>(
      `SELECT user_id, trust_score, trust_tier FROM users WHERE user_id = $1`,
      [user_id],
    );
    if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'User not found.');

    const features = await extractFeatures(user_id).catch(() => null);
    const predictedLabel =
      user.trust_tier === 'premium' || user.trust_tier === 'verified' ? 'normal' : 'suspicious';

    await mlSendFeedback(user_id, true_label, predictedLabel, features ?? {});

    await query(
      `INSERT INTO behavior_events (user_id, event_type, metadata)
       VALUES ($1, 'ml_feedback_submitted', $2)`,
      [user_id, JSON.stringify({ true_label, predicted_label: predictedLabel, note: note ?? null })],
    );

    await logAction(user_id, 'ml_feedback', note, { true_label, predictedLabel }, adminRef);

    logger.info('admin/ml', 'Feedback submitted', { user_id, true_label, predictedLabel });
    res.json({ ok: true, data: { user_id, true_label, status: 'sent' } });
  } catch (err) {
    if (err instanceof z.ZodError) return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    next(err);
  }
});

// ─── POST /admin/ml/retrain ───────────────────────────────────────────────────

adminRouter.post('/ml/retrain', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const ML_BASE = process.env.ML_SERVICE_URL ?? 'http://localhost:8001';
    const ML_KEY  = process.env.ML_API_KEY     ?? '';

    const controller = new AbortController();
    setTimeout(() => controller.abort(), 10_000);

    const resp = await fetch(`${ML_BASE}/admin/train`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    ML_KEY,
        'X-Train-Key':  process.env.TRAIN_API_KEY ?? ML_KEY,
      },
      body:   JSON.stringify({}),
      signal: controller.signal,
    });

    if (!resp.ok) {
      const text = await resp.text().catch(() => resp.statusText);
      throw new AppError(502, 'ML_ERROR', `ML rejected retrain: ${text}`);
    }

    const data = await resp.json();
    logger.info('admin/ml', 'Retrain triggered');
    res.json({ ok: true, data });
  } catch (err: any) {
    if (err instanceof AppError) return next(err);
    next(new AppError(502, 'ML_UNAVAILABLE', `Could not reach ML service: ${err.message}`));
  }
});

// ─── GET /admin/ml/status ─────────────────────────────────────────────────────

adminRouter.get('/ml/status', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    res.json({ ok: true, data: await mlHealthCheck() });
  } catch (err) {
    next(err);
  }
});

// ─── GET /admin/users — paginated directory ───────────────────────────────────

adminRouter.get('/users', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const offset = Math.max(0, parseInt(String(req.query.offset ?? '0'), 10) || 0);
    const q = (req.query.q as string | undefined)?.trim();

    const hasSearch = !!q;
    const searchArg = hasSearch ? `%${q}%` : null;

    const [rows, countRow] = await Promise.all([
      query<{
        user_id: string;
        handle: string;
        display_name: string | null;
        phone_e164: string | null;
        trust_tier: string;
        trust_score: number;
        is_active: boolean;
        is_under_review: boolean;
        created_at: Date;
      }>(
        `SELECT user_id, handle, display_name, phone_e164,
                trust_tier::text AS trust_tier, trust_score, is_active, is_under_review, created_at
         FROM users
         WHERE ($1::text IS NULL OR handle ILIKE $1 OR display_name ILIKE $1 OR phone_e164 ILIKE $1)
         ORDER BY created_at DESC
         LIMIT $2 OFFSET $3`,
        [searchArg, limit, offset],
      ),
      queryOne<{ total: string }>(
        `SELECT COUNT(*)::text AS total FROM users
         WHERE ($1::text IS NULL OR handle ILIKE $1 OR display_name ILIKE $1 OR phone_e164 ILIKE $1)`,
        [searchArg],
      ),
    ]);

    res.json({
      ok: true,
      data: {
        users: rows,
        total: parseInt(countRow?.total ?? '0', 10),
        limit,
        offset,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─── Business Suite admin ─────────────────────────────────────────────────────

adminRouter.get('/businesses/stats', async (_req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await queryOne<{
      total: string;
      pending: string;
      verified: string;
      suspended: string;
      starter: string;
      growth: string;
      enterprise: string;
    }>(
      `SELECT
         COUNT(*)::text AS total,
         COUNT(*) FILTER (WHERE status = 'pending')::text AS pending,
         COUNT(*) FILTER (WHERE status = 'verified')::text AS verified,
         COUNT(*) FILTER (WHERE status = 'suspended')::text AS suspended,
         COUNT(*) FILTER (WHERE plan = 'starter')::text AS starter,
         COUNT(*) FILTER (WHERE plan = 'growth')::text AS growth,
         COUNT(*) FILTER (WHERE plan = 'enterprise')::text AS enterprise
       FROM businesses`,
    );
    res.json({ ok: true, data: row });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/businesses', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const status = (req.query.status as string) || 'pending';
    const limit = Math.min(100, Math.max(1, parseInt(String(req.query.limit ?? '50'), 10) || 50));
    const rows = await query(
      `SELECT business_id, name, gstin, cin, category, contact_email, website,
              status::text AS status, plan::text AS plan, created_at
       FROM businesses
       WHERE status = $1::business_status
       ORDER BY created_at ASC
       LIMIT $2`,
      [status, limit],
    );
    res.json({ ok: true, data: rows });
  } catch (err) {
    next(err);
  }
});

adminRouter.get('/businesses/:id', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const row = await queryOne(
      `SELECT business_id, name, gstin, cin, category, contact_email, website, logo_url,
              status::text AS status, plan::text AS plan, rejection_reason,
              verified_at, suspended_at, created_at, updated_at
       FROM businesses WHERE business_id = $1`,
      [req.params.id],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Business not found.');

    const channels = await query(
      `SELECT channel_id, name, channel_type::text AS channel_type, active, created_at
       FROM business_channels WHERE business_id = $1`,
      [req.params.id],
    );

    res.json({ ok: true, data: { ...row, channels } });
  } catch (err) {
    next(err);
  }
});

const rejectBusinessSchema = z.object({
  reason: z.string().min(3).max(500),
});

const approveBusinessSchema = z.object({
  plan: z.enum(['starter', 'growth', 'enterprise']).optional(),
});

adminRouter.post('/businesses/:id/approve', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const body = approveBusinessSchema.parse(req.body ?? {});
    const biz = await queryOne<{ business_id: string; status: string }>(
      `SELECT business_id, status::text AS status FROM businesses WHERE business_id = $1`,
      [req.params.id],
    );
    if (!biz) throw new AppError(404, 'NOT_FOUND', 'Business not found.');
    if (biz.status !== 'pending') {
      throw new AppError(409, 'NOT_PENDING', 'Only pending businesses can be approved.');
    }

    const { rawKey, keyHash } = generateApiKey();
    const plan = body.plan ?? 'starter';

    await query(
      `UPDATE businesses
       SET status = 'verified', api_key_hash = $1, plan = $2::business_plan,
           verified_at = NOW(), rejection_reason = NULL, updated_at = NOW()
       WHERE business_id = $3`,
      [keyHash, plan, req.params.id],
    );

    await logAction(req.params.id, 'business_approved', null, { plan }, req.headers['x-admin-ref'] as string);

    res.json({
      ok: true,
      data: {
        business_id: req.params.id,
        status: 'verified',
        api_key: rawKey,
        message: 'Store this API key securely — it will not be shown again.',
      },
    });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

adminRouter.post('/businesses/:id/reject', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const { reason } = rejectBusinessSchema.parse(req.body);
    const [row] = await query(
      `UPDATE businesses
       SET status = 'rejected', rejection_reason = $1, updated_at = NOW()
       WHERE business_id = $2 AND status = 'pending'
       RETURNING business_id`,
      [reason.trim(), req.params.id],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Pending business not found.');

    await logAction(req.params.id, 'business_rejected', reason, {}, req.headers['x-admin-ref'] as string);
    res.json({ ok: true, data: { business_id: row.business_id, status: 'rejected' } });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(new AppError(400, 'VALIDATION_ERROR', err.errors[0].message));
    }
    next(err);
  }
});

adminRouter.post('/businesses/:id/suspend', async (req: Request, res: Response, next: NextFunction) => {
  try {
    const [row] = await query(
      `UPDATE businesses
       SET status = 'suspended', suspended_at = NOW(), updated_at = NOW()
       WHERE business_id = $1 AND status = 'verified'
       RETURNING business_id`,
      [req.params.id],
    );
    if (!row) throw new AppError(404, 'NOT_FOUND', 'Verified business not found.');

    await logAction(req.params.id, 'business_suspended', null, {}, req.headers['x-admin-ref'] as string);
    res.json({ ok: true, data: { business_id: row.business_id, status: 'suspended' } });
  } catch (err) {
    next(err);
  }
});
