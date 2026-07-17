/**
 * Deterministic, ML-free trust-score utilities. Maps a user's completed trust_factors
 * plus profile completeness and account age into a verification-point total, and maps a
 * numeric score to a tier. The ML behavioural modifier (mlClient) is added on top.
 *
 * Weight table (max verification = 90):
 *   phone_verified +15 · device_integrity +10 · liveness_check +25 · govt_id_verified +30
 *   profile_complete +5 · account_age +5 (linear, maxes at 180 days)
 */
import { db, users, trustFactors, eq, and, sql, type TrustTier } from '@trustroute/core';

export const VERIFICATION_WEIGHTS = {
  phone_verified: 15,
  device_integrity: 10,
  liveness_check: 25,
  govt_id_verified: 30,
  profile_complete: 5,
  account_age: 5,
} as const;

const TIER_THRESHOLDS: Array<{ tier: TrustTier; min: number }> = [
  { tier: 'premium', min: 80 },
  { tier: 'verified', min: 50 },
  { tier: 'basic', min: 30 },
  { tier: 'anonymous', min: 0 },
];

export const REVIEW_THRESHOLD = 20;

export function scoreToTier(score: number): TrustTier {
  for (const { tier, min } of TIER_THRESHOLDS) if (score >= min) return tier;
  return 'anonymous';
}

export function clampScore(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw)));
}

/** Fetch completed factors + profile and return the deterministic verification total. */
export async function computeVerificationPoints(userId: string): Promise<number> {
  const [factorRows, [user]] = await Promise.all([
    db
      .select({ factorType: trustFactors.factorType })
      .from(trustFactors)
      .where(and(eq(trustFactors.userId, userId), eq(trustFactors.status, 'completed'), eq(trustFactors.isLatest, true))),
    db
      .select({ displayName: users.displayName, avatarUrl: users.avatarUrl, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1),
  ]);
  if (!user) return 0;

  const completed = new Set(factorRows.map((r) => r.factorType));
  const profileDone = !!(user.displayName?.trim() && user.avatarUrl);
  const ageDays = Math.floor((Date.now() - new Date(user.createdAt).getTime()) / 86_400_000);

  let total = 0;
  if (completed.has('phone_verified')) total += VERIFICATION_WEIGHTS.phone_verified;
  if (completed.has('device_integrity')) total += VERIFICATION_WEIGHTS.device_integrity;
  if (completed.has('liveness_check')) total += VERIFICATION_WEIGHTS.liveness_check;
  if (completed.has('govt_id_verified')) total += VERIFICATION_WEIGHTS.govt_id_verified;
  if (profileDone) total += VERIFICATION_WEIGHTS.profile_complete;
  total += Math.min(VERIFICATION_WEIGHTS.account_age, Math.round((ageDays / 180) * VERIFICATION_WEIGHTS.account_age));
  return total;
}

// `sql` re-exported so job files can build the FOR UPDATE lock without another import.
export { sql };
