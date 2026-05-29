/**
 * PrivID Trust Score Engine — v2
 *
 * Score range: 0 – 100
 * Tier thresholds:
 *   anonymous  0  – 29
 *   basic      30 – 49
 *   verified   50 – 79
 *   premium    80 – 100
 *
 * Factor weights (max contribution):
 *   phone_verified      +15   (gate factor)
 *   device_integrity    +10
 *   liveness_check      +25
 *   govt_id_verified    +30
 *   profile_complete    +5
 *   account_age         +5    (max after 180 days)
 *   network_trust       +10   (avg trust of trusted connections)
 *
 * Penalties (combined cap = -40):
 *   blocks_received     -3 each (cap -15, 30-day window)
 *   mass_outreach_flags -5 each (cap -10, 30-day window)
 *   call_freq_penalty   -20 max  (situational, frequency + velocity + unanswered rate)
 *
 * Auto-review: score < 20 AND declining → is_under_review = true
 * Callers under review cannot initiate calls to unknown contacts.
 */

import { query, queryOne, withTransaction } from '@privid/shared';
import type { TrustTier, UserRow } from '@privid/shared';

// ─── Constants ────────────────────────────────────────────────────────────────

export const TRUST_FACTOR_WEIGHTS: Record<string, number> = {
  phone_verified:   15,
  device_integrity: 10,
  liveness_check:   25,
  govt_id_verified: 30,
  profile_complete: 5,
  account_age:      5,
  network_trust:    10,
};

export const TIER_THRESHOLDS: { tier: TrustTier; min: number }[] = [
  { tier: 'premium',   min: 80 },
  { tier: 'verified',  min: 50 },
  { tier: 'basic',     min: 30 },
  { tier: 'anonymous', min: 0  },
];

export const REVIEW_THRESHOLD = 20;

export function scoreToTier(score: number): TrustTier {
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (score >= min) return tier;
  }
  return 'anonymous';
}

// ─── Static factor helpers ────────────────────────────────────────────────────

async function getCompletedFactors(userId: string): Promise<Set<string>> {
  const rows = await query(
    `SELECT factor_type FROM trust_factors WHERE user_id = $1 AND status = 'completed'`,
    [userId]
  );
  return new Set(rows.map((r) => r.factor_type));
}

async function getProfileCompleteness(userId: string): Promise<boolean> {
  const user = await queryOne<UserRow>(
    `SELECT display_name, avatar_url FROM users WHERE user_id = $1`,
    [userId]
  );
  return !!(user?.display_name && user?.avatar_url);
}

async function getAccountAgeDays(userId: string): Promise<number> {
  const row = await queryOne<{ days: number }>(
    `SELECT EXTRACT(DAY FROM NOW() - created_at)::int AS days FROM users WHERE user_id = $1`,
    [userId]
  );
  return row?.days ?? 0;
}

async function getNetworkTrustScore(userId: string): Promise<number> {
  const row = await queryOne<{ avg_score: string | null }>(
    `SELECT AVG(u.trust_score)::numeric(5,2) AS avg_score
     FROM connections c
     JOIN users u ON u.user_id = c.contact_id
     WHERE c.owner_id = $1 AND c.connection_type = 'trusted'`,
    [userId]
  );
  const avg = parseFloat(row?.avg_score ?? '0');
  return avg ? Math.min(10, Math.round((avg / 70) * 10)) : 0;
}

// ─── Behavioral penalty (static signals) ─────────────────────────────────────

async function getStaticBehaviorPenalty(userId: string): Promise<number> {
  const [blocks, flags] = await Promise.all([
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM connections
       WHERE contact_id = $1 AND connection_type = 'blocked'
         AND updated_at > NOW() - INTERVAL '30 days'`,
      [userId],
    ),
    query<{ count: string }>(
      `SELECT COUNT(*) as count FROM behavior_events
       WHERE user_id = $1 AND event_type = 'mass_outreach_flag'
         AND created_at > NOW() - INTERVAL '30 days'`,
      [userId],
    ),
  ]);
  const blockPenalty   = Math.min(15, parseInt(blocks[0].count)  * 3);
  const outreachPenalty = Math.min(10, parseInt(flags[0].count)  * 5);
  return blockPenalty + outreachPenalty;
}

// ─── Call frequency / velocity penalty (dynamic, situational) ────────────────
//
// This replaces the flat "mass_outreach > 70% decline" with a continuous,
// frequency-aware signal. We look at 3 dimensions:
//
//   1. Daily volume to unknowns  — penalizes high raw volume
//   2. Day-over-day acceleration — penalizes rapidly increasing pace
//   3. Unanswered rate trend     — penalizes consistently ignored calls
//
// Design goals:
//   - A recruiter making 15 calls/day ALL answered: penalty ≈ 0
//   - A spammer making 15 calls/day NONE answered: penalty ≈ 10-15
//   - A spammer DOUBLING their call rate each day: extra acceleration penalty
//   - A reformed spammer reducing calls: penalty decreases over days

async function getCallFrequencyPenalty(userId: string): Promise<number> {
  // Per-day stats for last 5 days
  const rows = await query<{
    day: string;
    calls_to_unknowns: string;
    total_calls: string;
    unanswered: string;
  }>(`
    SELECT
      DATE(c.created_at) AS day,
      COUNT(*) FILTER (
        WHERE NOT EXISTS (
          SELECT 1 FROM connections cc
          WHERE cc.owner_id = c.callee_id
            AND cc.contact_id = c.caller_id
            AND cc.connection_type NOT IN ('unknown', 'blocked')
        )
      )::text AS calls_to_unknowns,
      COUNT(*)::text AS total_calls,
      COUNT(*) FILTER (WHERE c.status NOT IN ('answered','ended'))::text AS unanswered
    FROM calls c
    WHERE c.caller_id = $1
      AND c.created_at > NOW() - INTERVAL '5 days'
    GROUP BY DATE(c.created_at)
    ORDER BY day ASC
  `, [userId]);

  if (rows.length === 0) return 0;

  let penalty = 0;

  for (let i = 0; i < rows.length; i++) {
    const cu  = parseInt(rows[i].calls_to_unknowns);
    const tot = parseInt(rows[i].total_calls);
    const una = parseInt(rows[i].unanswered);

    // 1. Volume penalty (per day)
    if (cu >= 30) penalty += 6;
    else if (cu >= 20) penalty += 4;
    else if (cu >= 10) penalty += 2;
    else if (cu >= 5)  penalty += 1;

    // 2. Unanswered rate (only matters when volume is meaningful)
    if (cu >= 5) {
      const uRate = una / tot;
      if (uRate >= 0.95) penalty += 5;
      else if (uRate >= 0.80) penalty += 3;
      else if (uRate >= 0.65) penalty += 1;
      // Good answer rate actively reduces accumulated penalty
      else if (uRate <= 0.20) penalty -= 1;
    }

    // 3. Acceleration: this day > 1.5× the previous day's unknown calls
    if (i > 0) {
      const prev = parseInt(rows[i - 1].calls_to_unknowns);
      if (prev > 0 && cu / prev >= 2.0) penalty += 4;       // 2×+ daily jump
      else if (prev > 0 && cu / prev >= 1.5) penalty += 2;  // 1.5× jump
      // Deceleration is rewarded
      else if (prev > 5 && cu / prev <= 0.5) penalty -= 2;
    }
  }

  return Math.max(0, Math.min(20, penalty));
}

// ─── Core score computation ───────────────────────────────────────────────────

export interface TrustBreakdown {
  total: number;
  tier: TrustTier;
  factors: {
    phone_verified: number;
    device_integrity: number;
    liveness_check: number;
    govt_id_verified: number;
    profile_complete: number;
    account_age: number;
    network_trust: number;
    behavior_modifier: number;
    call_freq_penalty: number;
  };
}

export async function computeTrustScore(userId: string): Promise<TrustBreakdown> {
  const [completed, profileDone, ageDays, networkScore, staticPenalty, freqPenalty] = await Promise.all([
    getCompletedFactors(userId),
    getProfileCompleteness(userId),
    getAccountAgeDays(userId),
    getNetworkTrustScore(userId),
    getStaticBehaviorPenalty(userId),
    getCallFrequencyPenalty(userId),
  ]);

  const totalPenalty = Math.min(40, staticPenalty + freqPenalty);

  const factors = {
    phone_verified:    completed.has('phone_verified')   ? 15 : 0,
    device_integrity:  completed.has('device_integrity') ? 10 : 0,
    liveness_check:    completed.has('liveness_check')   ? 25 : 0,
    govt_id_verified:  completed.has('govt_id_verified') ? 30 : 0,
    profile_complete:  profileDone ? 5 : 0,
    account_age:       Math.min(5, Math.round((ageDays / 180) * 5)),
    network_trust:     networkScore,
    behavior_modifier: -(staticPenalty),
    call_freq_penalty: -(freqPenalty),
  };

  const raw = (
    factors.phone_verified + factors.device_integrity + factors.liveness_check +
    factors.govt_id_verified + factors.profile_complete + factors.account_age +
    factors.network_trust - totalPenalty
  );
  const total = Math.max(0, Math.min(100, raw));
  return { total, tier: scoreToTier(total), factors };
}

// ─── Bulk compute for simulation (single SQL, no per-user queries) ───────────

export async function bulkComputeScores(userIds: string[]): Promise<Array<{
  user_id: string;
  computed_score: number;
  tier: TrustTier;
}>> {
  if (userIds.length === 0) return [];

  const rows = await query<{ user_id: string; computed_score: string }>(
    `WITH
      cf AS (
        SELECT user_id,
          SUM(CASE factor_type
            WHEN 'phone_verified'   THEN 15
            WHEN 'device_integrity' THEN 10
            WHEN 'liveness_check'   THEN 25
            WHEN 'govt_id_verified' THEN 30
            ELSE 0 END) AS base_pts
        FROM trust_factors
        WHERE user_id = ANY($1) AND status = 'completed'
        GROUP BY user_id
      ),
      aa AS (
        SELECT user_id,
          LEAST(5, FLOOR(EXTRACT(DAY FROM NOW() - created_at) / 180.0 * 5)::int) AS age_pts
        FROM users WHERE user_id = ANY($1)
      ),
      net AS (
        SELECT c.owner_id AS user_id,
          LEAST(10, ROUND(AVG(u.trust_score)::numeric / 70.0 * 10)::int) AS net_pts
        FROM connections c
        JOIN users u ON u.user_id = c.contact_id
        WHERE c.owner_id = ANY($1) AND c.connection_type = 'trusted'
        GROUP BY c.owner_id
      ),
      blk AS (
        SELECT contact_id AS user_id, LEAST(15, COUNT(*) * 3)::int AS blk_pen
        FROM connections
        WHERE contact_id = ANY($1) AND connection_type = 'blocked'
          AND updated_at > NOW() - INTERVAL '30 days'
        GROUP BY contact_id
      ),
      flg AS (
        SELECT user_id, LEAST(10, COUNT(*) * 5)::int AS flg_pen
        FROM behavior_events
        WHERE user_id = ANY($1) AND event_type = 'mass_outreach_flag'
          AND created_at > NOW() - INTERVAL '30 days'
        GROUP BY user_id
      ),
      vel AS (
        SELECT caller_id AS user_id,
          LEAST(20,
            (COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '24 hours')
              * CASE WHEN COUNT(*) FILTER (WHERE status NOT IN ('answered','ended')) * 1.0 / NULLIF(COUNT(*),0) > 0.9 THEN 6
                     WHEN COUNT(*) FILTER (WHERE status NOT IN ('answered','ended')) * 1.0 / NULLIF(COUNT(*),0) > 0.7 THEN 3
                     ELSE 0 END
            ) / GREATEST(1, 5)
          )::int AS vel_pen
        FROM calls
        WHERE caller_id = ANY($1) AND created_at > NOW() - INTERVAL '3 days'
        GROUP BY caller_id
      )
      SELECT
        u.user_id,
        GREATEST(0, LEAST(100,
          COALESCE(cf.base_pts, 0) +
          COALESCE(aa.age_pts, 0) +
          COALESCE(net.net_pts, 0) -
          COALESCE(blk.blk_pen, 0) -
          COALESCE(flg.flg_pen, 0) -
          COALESCE(vel.vel_pen, 0)
        ))::text AS computed_score
      FROM users u
      LEFT JOIN cf  ON cf.user_id  = u.user_id
      LEFT JOIN aa  ON aa.user_id  = u.user_id
      LEFT JOIN net ON net.user_id = u.user_id
      LEFT JOIN blk ON blk.user_id = u.user_id
      LEFT JOIN flg ON flg.user_id = u.user_id
      LEFT JOIN vel ON vel.user_id = u.user_id
      WHERE u.user_id = ANY($1)`,
    [userIds],
  );

  return rows.map(r => ({
    user_id: r.user_id,
    computed_score: parseInt(r.computed_score),
    tier: scoreToTier(parseInt(r.computed_score)),
  }));
}

// ─── Persist recomputed score + trigger review ────────────────────────────────

export async function recomputeAndPersist(userId: string): Promise<TrustBreakdown> {
  const breakdown = await computeTrustScore(userId);

  await withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `SELECT trust_score, trust_tier, is_under_review FROM users WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const current = rows[0];
    if (!current) return;

    await client.query(
      `UPDATE users SET trust_score = $1, trust_tier = $2 WHERE user_id = $3`,
      [breakdown.total, breakdown.tier, userId]
    );

    if (current.trust_score !== breakdown.total || current.trust_tier !== breakdown.tier) {
      await client.query(
        `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, current.trust_score, breakdown.total, current.trust_tier, breakdown.tier, 'recompute'],
      );
    }

    // Auto-review: score crosses below 20 for the first time
    if (
      breakdown.total < REVIEW_THRESHOLD &&
      current.trust_score >= REVIEW_THRESHOLD &&
      !current.is_under_review
    ) {
      const reason = breakdown.factors.call_freq_penalty < -5
        ? `Score dropped to ${breakdown.total} — abnormal call frequency pattern detected.`
        : `Score dropped to ${breakdown.total} — multiple blocks and/or outreach flags.`;
      await client.query(
        `UPDATE users SET is_under_review = true, review_reason = $1, review_started_at = NOW()
         WHERE user_id = $2`,
        [reason, userId],
      );
    }
  });

  return breakdown;
}
