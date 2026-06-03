/**
 * shared/src/scoring.ts
 *
 * Deterministic, ML-free trust-score utilities shared between the
 * API service and the background worker.
 *
 * Responsibilities:
 *   - Map completed trust_factors rows → verification point total
 *   - Map numeric score → tier label
 *
 * Deliberately contains NO ML calls, NO HTTP calls, NO Express types.
 * The ML behavioral modifier is computed separately by the API
 * (api/src/services/trustScore.ts) and the worker
 * (worker/src/utils/mlClient.ts), then added on top of these points.
 *
 * Weight table (must stay in sync with api/src/services/trustScore.ts):
 *   phone_verified      +15
 *   device_integrity    +10
 *   liveness_check      +25
 *   govt_id_verified    +30
 *   profile_complete     +5
 *   account_age          +5  (linear, max at 180 days)
 *   ─────────────────────────
 *   max verification    +90
 */

import { query, queryOne } from './db';
import type { TrustTier } from './types';

// ─── Constants ────────────────────────────────────────────────────────────────

export const VERIFICATION_WEIGHTS = {
  phone_verified:   15,
  device_integrity: 10,
  liveness_check:   25,
  govt_id_verified: 30,
  profile_complete:  5,
  account_age:       5,
} as const;

export const TIER_THRESHOLDS: Array<{ tier: TrustTier; min: number }> = [
  { tier: 'premium',   min: 80 },
  { tier: 'verified',  min: 50 },
  { tier: 'basic',     min: 30 },
  { tier: 'anonymous', min:  0 },
];

export const REVIEW_THRESHOLD = 20;

// ─── Result types ─────────────────────────────────────────────────────────────

export interface VerificationFactorPoints {
  phone_verified:   number;
  device_integrity: number;
  liveness_check:   number;
  govt_id_verified: number;
  profile_complete: number;
  account_age:      number;
}

export interface VerificationPoints {
  total:   number;
  factors: VerificationFactorPoints;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * scoreToTier — map a numeric score to the corresponding tier label.
 * Pure function, no I/O.
 */
export function scoreToTier(score: number): TrustTier {
  for (const { tier, min } of TIER_THRESHOLDS) {
    if (score >= min) return tier;
  }
  return 'anonymous';
}

/**
 * computeVerificationPoints — fetch completed trust_factors + user profile
 * from the database and return the deterministic point total.
 *
 * This is the ONLY source of truth for the verification part of the score.
 * Both the API service and the worker must call this function instead of
 * duplicating the SQL.
 *
 * Returns 0 for every factor if the user does not exist (fail-safe).
 */
export async function computeVerificationPoints(
  userId: string,
): Promise<VerificationPoints> {
  // Run factor fetch + profile fetch in parallel — both are small indexed reads.
  const [factorRows, user] = await Promise.all([
    query<{ factor_type: string }>(
      `SELECT factor_type
         FROM trust_factors
        WHERE user_id = $1
          AND status = 'completed'
          AND is_latest = TRUE`,
      [userId],
    ),
    queryOne<{ display_name: string | null; avatar_url: string | null; created_at: Date }>(
      `SELECT display_name, avatar_url, created_at
         FROM users
        WHERE user_id = $1`,
      [userId],
    ),
  ]);

  const completed = new Set(factorRows.map((r) => r.factor_type));

  const profileDone = !!(user?.display_name?.trim() && user?.avatar_url);

  const ageDays = user
    ? Math.floor((Date.now() - new Date(user.created_at).getTime()) / 86_400_000)
    : 0;

  const factors: VerificationFactorPoints = {
    phone_verified:   completed.has('phone_verified')   ? VERIFICATION_WEIGHTS.phone_verified   : 0,
    device_integrity: completed.has('device_integrity') ? VERIFICATION_WEIGHTS.device_integrity : 0,
    liveness_check:   completed.has('liveness_check')   ? VERIFICATION_WEIGHTS.liveness_check   : 0,
    govt_id_verified: completed.has('govt_id_verified') ? VERIFICATION_WEIGHTS.govt_id_verified : 0,
    profile_complete: profileDone                        ? VERIFICATION_WEIGHTS.profile_complete : 0,
    account_age:      Math.min(
      VERIFICATION_WEIGHTS.account_age,
      Math.round((ageDays / 180) * VERIFICATION_WEIGHTS.account_age),
    ),
  };

  const total =
    factors.phone_verified +
    factors.device_integrity +
    factors.liveness_check +
    factors.govt_id_verified +
    factors.profile_complete +
    factors.account_age;

  return { total, factors };
}

/**
 * clampScore — clamp a raw score into the valid 0–100 range.
 */
export function clampScore(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw)));
}
