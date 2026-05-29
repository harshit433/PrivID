/**
 * PrivID Trust Score Engine
 *
 * Score range: 0 – 100
 * Tier thresholds:
 *   anonymous  0  – 29
 *   basic      30 – 49
 *   verified   50 – 79
 *   premium    80 – 100
 *
 * Factor weights (max contribution):
 *   phone_verified      +15   (gate factor — required for any trust)
 *   device_integrity    +10   (Play Integrity / DeviceCheck)
 *   liveness_check      +25   (3DiVi liveness)
 *   govt_id_verified    +30   (Setu / DigiLocker Aadhaar or PAN)
 *   profile_complete    +5    (display name + avatar set)
 *   account_age         +5    (max after 180 days)
 *   network_trust       +10   (avg trust of trusted connections, network effect)
 *   behavior_modifier   –20 – +0  (penalty only; mass outreach, blocks received)
 *
 *   Max theoretical: 100
 */

import { query, queryOne, withTransaction } from '@privid/shared';
import type { TrustTier, UserRow } from '@privid/shared';

// ─── Constants ────────────────────────────────────────────────────────────────

export const TRUST_FACTOR_WEIGHTS: Record<string, number> = {
  phone_verified: 15,
  device_integrity: 10,
  liveness_check: 25,
  govt_id_verified: 30,
  profile_complete: 5,
  account_age: 5,       // prorated up to 180 days
  network_trust: 10,    // computed dynamically
  behavior_modifier: 0, // penalty; computed dynamically (0 to -20)
};

export const TIER_THRESHOLDS: { tier: TrustTier; min: number }[] = [
  { tier: 'premium',   min: 80 },
  { tier: 'verified',  min: 50 },
  { tier: 'basic',     min: 30 },
  { tier: 'anonymous', min: 0  },
];

export function scoreToTier(score: number): TrustTier {
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (score >= min) return tier;
  }
  return 'anonymous';
}

// ─── Factor helpers ───────────────────────────────────────────────────────────

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
  // Average trust_score of users that this user has marked as 'trusted'
  const row = await queryOne<{ avg_score: string | null }>(
    `SELECT AVG(u.trust_score)::numeric(5,2) AS avg_score
     FROM connections c
     JOIN users u ON u.user_id = c.contact_id
     WHERE c.owner_id = $1 AND c.connection_type = 'trusted'`,
    [userId]
  );
  const avg = parseFloat(row?.avg_score ?? '0');
  if (!avg) return 0;
  // Normalize: if avg trusted contacts score is 70+, full 10 points
  return Math.min(10, Math.round((avg / 70) * 10));
}

async function getBehaviorPenalty(userId: string): Promise<number> {
  // Check for negative signals in the last 30 days:
  //   - blocks_received: each block = -3 (max -15)
  //   - mass_outreach_flags: each flag = -5 (max -20 total)
  const [blocks] = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM connections
     WHERE contact_id = $1
       AND connection_type = 'blocked'
       AND updated_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );
  const [flags] = await query<{ count: string }>(
    `SELECT COUNT(*) as count
     FROM behavior_events
     WHERE user_id = $1
       AND event_type = 'mass_outreach_flag'
       AND created_at > NOW() - INTERVAL '30 days'`,
    [userId]
  );

  const blockPenalty = Math.min(15, parseInt(blocks.count) * 3);
  const outreachPenalty = Math.min(20, parseInt(flags.count) * 5);
  return Math.min(20, blockPenalty + outreachPenalty); // total penalty cap = 20
}

// ─── Core recompute function ──────────────────────────────────────────────────

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
  };
}

export async function computeTrustScore(userId: string): Promise<TrustBreakdown> {
  const [completed, profileDone, ageDays, networkScore, behaviorPenalty] = await Promise.all([
    getCompletedFactors(userId),
    getProfileCompleteness(userId),
    getAccountAgeDays(userId),
    getNetworkTrustScore(userId),
    getBehaviorPenalty(userId),
  ]);

  const factors = {
    phone_verified:   completed.has('phone_verified')   ? TRUST_FACTOR_WEIGHTS.phone_verified   : 0,
    device_integrity: completed.has('device_integrity') ? TRUST_FACTOR_WEIGHTS.device_integrity : 0,
    liveness_check:   completed.has('liveness_check')   ? TRUST_FACTOR_WEIGHTS.liveness_check   : 0,
    govt_id_verified: completed.has('govt_id_verified') ? TRUST_FACTOR_WEIGHTS.govt_id_verified : 0,
    profile_complete: profileDone                        ? TRUST_FACTOR_WEIGHTS.profile_complete  : 0,
    account_age:      Math.min(5, Math.round((ageDays / 180) * 5)),
    network_trust:    networkScore,
    behavior_modifier: -behaviorPenalty,
  };

  const raw = Object.values(factors).reduce((a, b) => a + b, 0);
  const total = Math.max(0, Math.min(100, raw));
  const tier = scoreToTier(total);

  return { total, tier, factors };
}

// ─── Persist recomputed score ─────────────────────────────────────────────────

export async function recomputeAndPersist(userId: string): Promise<TrustBreakdown> {
  const breakdown = await computeTrustScore(userId);

  await withTransaction(async (client) => {
    const { rows } = await client.query<UserRow>(
      `SELECT trust_score, trust_tier FROM users WHERE user_id = $1 FOR UPDATE`,
      [userId]
    );
    const current = rows[0];
    if (!current) return;

    await client.query(
      `UPDATE users SET trust_score = $1, trust_tier = $2 WHERE user_id = $3`,
      [breakdown.total, breakdown.tier, userId]
    );

    // Record history if changed
    if (current.trust_score !== breakdown.total || current.trust_tier !== breakdown.tier) {
      await client.query(
        `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, current.trust_score, breakdown.total, current.trust_tier, breakdown.tier, 'recompute']
      );
    }
  });

  return breakdown;
}
