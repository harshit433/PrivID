/**
 * TrustRoute Trust Score Engine — v3 (Pure ML)
 *
 * Score range: 0 – 100
 * Tier thresholds:
 *   anonymous  0  – 29
 *   basic      30 – 49
 *   verified   50 – 79
 *   premium    80 – 100
 *
 * Architecture:
 *   Verification factors (objective, deterministic):
 *     phone_verified      +15
 *     device_integrity    +10
 *     liveness_check      +25
 *     govt_id_verified    +30
 *     profile_complete    +5
 *     account_age         +5   (max after 180 days)
 *     ─────────────────────────
 *     max verification    +90
 *
 *   ML behavioral modifier (Python ensemble service):
 *     CallBehaviorClassifier + AnomalyDetector + TrustScoreEnsemble
 *     range: [-40, +10]
 *
 *   final = clamp(verification_pts + ml_modifier, 0, 100)
 *
 * All rule-based behavioral penalties (block counting, frequency bands,
 * outreach flags, network trust) have been removed. The ML ensemble
 * handles every behavioral signal with higher accuracy and context-awareness.
 *
 * Auto-review triggers:
 *   - ML ensemble sets override_review = true (high-confidence bad actor)
 *   - Score drops below 20 for the first time (behavioral degradation)
 */

import { query, queryOne, withTransaction, getRedis, keys } from '@trustroute/shared';
import {
  computeVerificationPoints,
  scoreToTier,
  clampScore,
  VERIFICATION_WEIGHTS,
  TIER_THRESHOLDS,
  REVIEW_THRESHOLD,
} from '@trustroute/shared';
import type { TrustTier, UserRow } from '@trustroute/shared';
import { extractFeatures } from './featureStore';
import { mlScoreUser, mlBatchScore } from './mlClient';
import type { UserFeatures } from './featureStore';
import { scheduleTrustRecompute } from './trustQueue';

const TRUST_SCORE_TTL_S = 300; // 5 minutes — short enough to stay fresh, long enough to avoid redundant ML calls

// Re-export constants for backward compat with any other imports
export { VERIFICATION_WEIGHTS, TIER_THRESHOLDS, REVIEW_THRESHOLD, scoreToTier };

// ─── Score breakdown types ─────────────────────────────────────────────────────

export interface TrustBreakdown {
  total: number;
  tier:  TrustTier;
  factors: {
    phone_verified:   number;
    device_integrity: number;
    liveness_check:   number;
    govt_id_verified: number;
    profile_complete: number;
    account_age:      number;
    ml_modifier:      number;   // replaces all former behavioral penalties
  };
  ml?: {
    persona_prediction: string;
    confidence:         number;
    flags:              string[];
    model_agreement:    number;
    override_review:    boolean;
  };
}

// ─── Core score computation ────────────────────────────────────────────────────

/**
 * Clears the cached trust score for a user.
 * Call after any operation that changes trust factors (factor completion,
 * recomputeAndPersist, admin adjustments) so the next read gets fresh data.
 */
export async function invalidateTrustScoreCache(userId: string): Promise<void> {
  try {
    await getRedis().del(keys.trustScore(userId));
  } catch { /* Redis unavailable — next read will recompute */ }
}

export async function computeTrustScore(userId: string): Promise<TrustBreakdown> {
  // ── Cache check (Redis) ────────────────────────────────────────────────────
  // Trust scores are expensive: verification DB queries + ML HTTP call (100–500ms).
  // A 5-min TTL keeps the UI fresh without hammering the ML service on every
  // HomeScreen focus. Invalidated immediately after recomputeAndPersist().
  try {
    const redis = getRedis();
    const cached = await redis.get(keys.trustScore(userId));
    if (cached) return JSON.parse(cached) as TrustBreakdown;
  } catch { /* Redis down — fall through to live computation */ }

  // Verification points (shared, deterministic) + ML feature extraction in parallel
  const [verif, userFeatures] = await Promise.all([
    computeVerificationPoints(userId),
    extractFeatures(userId).catch(() => null),
  ]);

  const factors = {
    ...verif.factors,
    ml_modifier: 0,
  };

  // ── ML behavioral modifier (fail-open: 0 if service unavailable) ────────────
  let mlResult: TrustBreakdown['ml'] | undefined;

  if (userFeatures) {
    try {
      const ml = await mlScoreUser(userFeatures);
      factors.ml_modifier = ml.ml_score_delta;
      mlResult = {
        persona_prediction: ml.persona_prediction,
        confidence:         ml.confidence,
        flags:              ml.ml_flags,
        model_agreement:    ml.model_agreement,
        override_review:    ml.override_review,
      };
    } catch {
      // ML service down — verification-only score, no behavioral modifier applied
    }
  }

  const total = clampScore(verif.total + factors.ml_modifier);
  const result: TrustBreakdown = { total, tier: scoreToTier(total), factors, ml: mlResult };

  // Write to cache (fire-and-forget — never block the response on a Redis write)
  getRedis().setex(keys.trustScore(userId), TRUST_SCORE_TTL_S, JSON.stringify(result)).catch(() => {});

  return result;
}

/** Fire-and-forget full score computation to warm Redis (never blocks callers). */
export function warmTrustScoreCache(userId: string): void {
  computeTrustScore(userId).catch(() => {});
}

/**
 * Fast read path for API responses — avoids ML + feature extraction on cache miss.
 * Uses Redis when available, otherwise persisted user row + verification breakdown.
 */
export async function getTrustScoreSnapshot(userId: string): Promise<TrustBreakdown> {
  try {
    const cached = await getRedis().get(keys.trustScore(userId));
    if (cached) return JSON.parse(cached) as TrustBreakdown;
  } catch { /* fall through */ }

  const [verif, user] = await Promise.all([
    computeVerificationPoints(userId),
    queryOne<Pick<UserRow, 'trust_score' | 'trust_tier'>>(
      `SELECT trust_score, trust_tier FROM users WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const persisted = user?.trust_score ?? verif.total;
  const mlModifier = clampScore(persisted) - verif.total;
  const factors = { ...verif.factors, ml_modifier: mlModifier };
  const total = user ? user.trust_score : verif.total;
  const tier = user ? user.trust_tier : scoreToTier(verif.total);

  return { total, tier, factors };
}

/**
 * After a trust factor changes: invalidate cache, enqueue worker recompute,
 * return an immediate verification-based snapshot (ML updates async).
 */
export async function finalizeTrustFactor(userId: string, reason: string): Promise<TrustBreakdown> {
  await invalidateTrustScoreCache(userId);
  scheduleTrustRecompute(userId, reason);

  const verif = await computeVerificationPoints(userId);
  const snapshot: TrustBreakdown = {
    total: verif.total,
    tier: scoreToTier(verif.total),
    factors: { ...verif.factors, ml_modifier: 0 },
  };

  warmTrustScoreCache(userId);
  return snapshot;
}

// ─── Bulk compute (simulation + admin jobs) ───────────────────────────────────
//
// Efficient path for scoring many users at once:
//   1. Single SQL to get verification points for all users
//   2. Single SQL to extract core behavioral features for all users
//   3. One HTTP call to ML /batch-score
//   4. Combine: verification_pts + ml_delta per user

export async function bulkComputeScores(userIds: string[]): Promise<Array<{
  user_id:        string;
  computed_score: number;
  tier:           TrustTier;
}>> {
  if (userIds.length === 0) return [];

  // ── 1. Verification points (single SQL) ─────────────────────────────────────
  const verRows = await query<{
    user_id:   string;
    base_pts:  string;
    age_pts:   string;
    has_profile: string;
  }>(
    `WITH
       cf AS (
         SELECT user_id,
           SUM(CASE factor_type
             WHEN 'phone_verified'   THEN 15
             WHEN 'device_integrity' THEN 10
             WHEN 'liveness_check'   THEN 25
             WHEN 'govt_id_verified' THEN 30
             ELSE 0 END)::int AS base_pts
         FROM trust_factors
         WHERE user_id = ANY($1) AND status = 'completed'
         GROUP BY user_id
       ),
       aa AS (
         SELECT user_id,
           LEAST(5, FLOOR(EXTRACT(DAY FROM NOW() - created_at) / 180.0 * 5)::int) AS age_pts,
           CASE WHEN display_name IS NOT NULL AND avatar_url IS NOT NULL THEN 5 ELSE 0 END AS has_profile
         FROM users WHERE user_id = ANY($1)
       )
     SELECT
       u.user_id,
       (COALESCE(cf.base_pts, 0) + COALESCE(aa.age_pts, 0) + COALESCE(aa.has_profile, 0))::text AS base_pts,
       COALESCE(aa.age_pts, 0)::text   AS age_pts,
       COALESCE(aa.has_profile, 0)::text AS has_profile
     FROM users u
     LEFT JOIN cf ON cf.user_id = u.user_id
     LEFT JOIN aa ON aa.user_id = u.user_id
     WHERE u.user_id = ANY($1)`,
    [userIds],
  );

  const verMap = new Map(verRows.map(r => [r.user_id, parseInt(r.base_pts)]));

  // ── 2. Bulk behavioral features (single SQL) ─────────────────────────────────
  const featRows = await query<{
    user_id:                     string;
    calls_out_1d:                string;
    calls_out_7d:                string;
    calls_out_30d:               string;
    calls_in_7d:                 string;
    unique_callees_1d:           string;
    unique_callees_7d:           string;
    answer_rate_out_7d:          string;
    avg_call_duration_7d:        string;
    pct_calls_under_30s_7d:      string;
    blocked_by_7d:               string;
    blocked_by_30d:              string;
    trusted_contacts_count:      string;
  }>(
    `WITH
       vol_out AS (
         SELECT caller_id AS user_id,
           COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '1 day')   AS calls_out_1d,
           COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days')  AS calls_out_7d,
           COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '30 days') AS calls_out_30d,
           COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW()-INTERVAL '1 day')  AS unique_callees_1d,
           COUNT(DISTINCT callee_id) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS unique_callees_7d,
           AVG(CASE WHEN status='answered' THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS answer_rate_out_7d,
           AVG(EXTRACT(EPOCH FROM (ended_at - created_at)))
             FILTER (WHERE status='answered' AND created_at > NOW()-INTERVAL '7 days') AS avg_call_duration_7d,
           AVG(CASE WHEN EXTRACT(EPOCH FROM (ended_at - created_at)) < 30 THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS pct_calls_under_30s_7d
         FROM calls WHERE caller_id = ANY($1)
         GROUP BY caller_id
       ),
       vol_in AS (
         SELECT callee_id AS user_id,
           COUNT(*) FILTER (WHERE created_at > NOW()-INTERVAL '7 days') AS calls_in_7d
         FROM calls WHERE callee_id = ANY($1)
         GROUP BY callee_id
       ),
       net AS (
         SELECT contact_id AS user_id,
           COUNT(*) FILTER (WHERE connection_type='trusted') AS trusted_contacts_count,
           COUNT(*) FILTER (WHERE connection_type='blocked' AND updated_at > NOW()-INTERVAL '7 days')  AS blocked_by_7d,
           COUNT(*) FILTER (WHERE connection_type='blocked' AND updated_at > NOW()-INTERVAL '30 days') AS blocked_by_30d
         FROM connections WHERE contact_id = ANY($1)
         GROUP BY contact_id
       )
     SELECT
       u.user_id,
       COALESCE(vol_out.calls_out_1d,   0)::text AS calls_out_1d,
       COALESCE(vol_out.calls_out_7d,   0)::text AS calls_out_7d,
       COALESCE(vol_out.calls_out_30d,  0)::text AS calls_out_30d,
       COALESCE(vol_in.calls_in_7d,     0)::text AS calls_in_7d,
       COALESCE(vol_out.unique_callees_1d,  0)::text AS unique_callees_1d,
       COALESCE(vol_out.unique_callees_7d,  0)::text AS unique_callees_7d,
       COALESCE(vol_out.answer_rate_out_7d, 1.0)::text AS answer_rate_out_7d,
       COALESCE(vol_out.avg_call_duration_7d, 0)::text AS avg_call_duration_7d,
       COALESCE(vol_out.pct_calls_under_30s_7d, 0)::text AS pct_calls_under_30s_7d,
       COALESCE(net.blocked_by_7d,  0)::text AS blocked_by_7d,
       COALESCE(net.blocked_by_30d, 0)::text AS blocked_by_30d,
       COALESCE(net.trusted_contacts_count, 0)::text AS trusted_contacts_count
     FROM users u
     LEFT JOIN vol_out ON vol_out.user_id = u.user_id
     LEFT JOIN vol_in  ON vol_in.user_id  = u.user_id
     LEFT JOIN net     ON net.user_id     = u.user_id
     WHERE u.user_id = ANY($1)`,
    [userIds],
  );

  // ── 3. Build feature vectors + call ML batch-score ───────────────────────────
  const featuresList: UserFeatures[] = featRows.map(r => ({
    user_id:    r.user_id,
    computed_at: new Date().toISOString(),
    // Identity (not in bulk SQL — treated as 0 for ML; verification handled separately)
    phone_verified: false, device_integrity: false, liveness_check: false,
    govt_id_verified: false, profile_completeness: 0, account_age_days: 0,
    // Volume
    calls_out_1d:  parseFloat(r.calls_out_1d),
    calls_out_7d:  parseFloat(r.calls_out_7d),
    calls_out_30d: parseFloat(r.calls_out_30d),
    calls_in_1d:   0,
    calls_in_7d:   parseFloat(r.calls_in_7d),
    calls_in_30d:  0,
    unique_callees_1d:  parseFloat(r.unique_callees_1d),
    unique_callees_7d:  parseFloat(r.unique_callees_7d),
    unique_callees_30d: 0,
    unique_callers_7d:  0,
    calls_per_unique_callee_1d: parseFloat(r.unique_callees_1d) > 0
      ? parseFloat(r.calls_out_1d) / parseFloat(r.unique_callees_1d) : 0,
    new_targets_1d: 0,
    // Quality
    answer_rate_out_1d: parseFloat(r.answer_rate_out_7d),
    answer_rate_out_7d: parseFloat(r.answer_rate_out_7d),
    answer_rate_in_1d:  1.0,
    answer_rate_in_7d:  1.0,
    avg_call_duration_7d:    parseFloat(r.avg_call_duration_7d),
    pct_calls_under_30s_7d:  parseFloat(r.pct_calls_under_30s_7d),
    reciprocal_rate_30d:     0,
    calls_to_trusted_ratio_7d: 0,
    // Behavioral (zeros — not computed in bulk path; ML handles gracefully)
    unknown_call_ratio_7d: 0,
    burst_count_7d:        0,
    burst_acceleration:    0,
    repeat_call_rate_7d:   0,
    sequential_dialing_max: 0,
    first_contact_ghost_ratio_30d: 0,
    consistent_ignorer_count_30d:  0,
    // Network
    trusted_contacts_count: parseFloat(r.trusted_contacts_count),
    blocked_by_7d:          parseFloat(r.blocked_by_7d),
    blocked_by_30d:         parseFloat(r.blocked_by_30d),
    block_trusted_ratio: parseFloat(r.trusted_contacts_count) > 0
      ? parseFloat(r.blocked_by_30d) / parseFloat(r.trusted_contacts_count) : 0,
    avg_trust_of_network:       0,
    shared_targets_with_flagged: 0,
    // Trend
    score_slope_7d:    0,
    behavior_regime:   'stable',
    regime_stable:     1,
    regime_escalating: 0,
    regime_declining:  0,
    regime_recovering: 0,
  }));

  const mlResults = await mlBatchScore(featuresList);
  const mlMap = new Map(mlResults.map(r => [r.user_id, r.ml_score_delta]));

  // ── 4. Combine ────────────────────────────────────────────────────────────────
  return userIds.map(uid => {
    const verPts = verMap.get(uid) ?? 0;
    const mlDelta = mlMap.get(uid) ?? 0;
    // trust_score is an INTEGER column (0–100); round so the DB cast never sees a float.
    const computed_score = Math.round(Math.max(0, Math.min(100, verPts + mlDelta)));
    return { user_id: uid, computed_score, tier: scoreToTier(computed_score) };
  });
}

// ─── Persist recomputed score + trigger review ────────────────────────────────

export async function recomputeAndPersist(userId: string): Promise<TrustBreakdown> {
  // Invalidate cache so computeTrustScore gets fresh ML data
  await invalidateTrustScoreCache(userId);

  // Compute fresh score (cache miss → calls ML service)
  const breakdown = await computeTrustScore(userId);

  await withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `SELECT trust_score, trust_tier, is_under_review FROM users WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const current = rows[0];
    if (!current) return;

    await client.query(
      `UPDATE users SET trust_score = $1, trust_tier = $2 WHERE user_id = $3`,
      [breakdown.total, breakdown.tier, userId],
    );

    if (current.trust_score !== breakdown.total || current.trust_tier !== breakdown.tier) {
      await client.query(
        `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, current.trust_score, breakdown.total, current.trust_tier, breakdown.tier, 'recompute'],
      );
    }

    // Auto-review triggers
    const mlOverride  = breakdown.ml?.override_review ?? false;
    const scoreDropped = breakdown.total < REVIEW_THRESHOLD && current.trust_score >= REVIEW_THRESHOLD;

    if (!current.is_under_review && (scoreDropped || mlOverride)) {
      let reason: string;
      if (mlOverride && breakdown.ml) {
        reason = `ML detected ${breakdown.ml.persona_prediction} with ${(breakdown.ml.confidence * 100).toFixed(0)}% confidence. ${breakdown.ml.flags.slice(0, 2).join(' ')}`;
      } else {
        reason = `Score dropped to ${breakdown.total} — abnormal behavioral pattern detected by ML.`;
      }
      await client.query(
        `UPDATE users SET is_under_review = true, review_reason = $1, review_started_at = NOW()
         WHERE user_id = $2`,
        [reason, userId],
      );
    }
  });

  return breakdown;
}
