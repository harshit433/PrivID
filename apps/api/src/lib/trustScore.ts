/**
 * Sync trust-score helpers for the API process. The worker job remains the
 * ML-aware path; these cover immediate verification-only updates (onboarding,
 * avatar) so the auth response and /me aren't stuck at 0 until a worker runs.
 */
import {
  db,
  users,
  trustFactors,
  trustScoreHistory,
  eq,
  and,
  sql,
  cacheDel,
  keys,
  type TrustTier,
} from '@trustroute/core';

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

export function scoreToTier(score: number): TrustTier {
  for (const { tier, min } of TIER_THRESHOLDS) if (score >= min) return tier;
  return 'anonymous';
}

export function clampScore(raw: number): number {
  return Math.max(0, Math.min(100, Math.round(raw)));
}

export async function computeVerificationPoints(userId: string): Promise<number> {
  const [factorRows, [user]] = await Promise.all([
    db
      .select({ factorType: trustFactors.factorType })
      .from(trustFactors)
      .where(
        and(
          eq(trustFactors.userId, userId),
          eq(trustFactors.status, 'completed'),
          eq(trustFactors.isLatest, true),
        ),
      ),
    db
      .select({
        displayName: users.displayName,
        avatarUrl: users.avatarUrl,
        createdAt: users.createdAt,
      })
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
  total += Math.min(
    VERIFICATION_WEIGHTS.account_age,
    Math.round((ageDays / 180) * VERIFICATION_WEIGHTS.account_age),
  );
  return total;
}

/** Persist verification-only score/tier when they changed. */
export async function persistVerificationScore(userId: string, reason: string): Promise<void> {
  const newScore = clampScore(await computeVerificationPoints(userId));
  const newTier = scoreToTier(newScore);

  const [cur] = await db
    .select({ trustScore: users.trustScore, trustTier: users.trustTier })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  if (!cur) return;
  if (cur.trustScore === newScore && cur.trustTier === newTier) return;

  await db
    .update(users)
    .set({ trustScore: newScore, trustTier: newTier, updatedAt: sql`now()` })
    .where(eq(users.userId, userId));
  await db.insert(trustScoreHistory).values({
    userId,
    oldScore: cur.trustScore,
    newScore,
    oldTier: cur.trustTier,
    newTier,
    reason,
  });
  await cacheDel(keys.trustScore(userId)).catch(() => {});
}
