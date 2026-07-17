/**
 * Trust recompute (per user). Combines the deterministic verification total with an
 * optional ML behavioural modifier (fail-open — verification-only when ML is down),
 * persists to `users` + `trust_score_history` only when the score/tier actually changed,
 * flips accounts into review on a sharp drop or ML override, and invalidates the cached
 * trust score so API reads stay consistent. Simulation handles (`tsim_`) are skipped.
 */
import { db, users, trustScoreHistory, eq, sql, cacheDel, keys, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';
import { computeVerificationPoints, scoreToTier, clampScore, REVIEW_THRESHOLD } from '../lib/scoring';
import { scoreByUserId } from '../lib/mlClient';

const LOG = 'worker:trust-recompute';

const process: Processor<JobMap['trust-recompute']> = async (job) => {
  const { user_id, reason } = job.data;

  const [guard] = await db.select({ handle: users.handle }).from(users).where(eq(users.userId, user_id)).limit(1);
  if (!guard) return;
  if (guard.handle.startsWith('tsim_')) return; // simulation account — never score

  const [verif, mlDelta] = await Promise.all([computeVerificationPoints(user_id), scoreByUserId(user_id)]);
  const newScore = clampScore(verif + (mlDelta?.ml_score_delta ?? 0));
  const newTier = scoreToTier(newScore);

  await db.transaction(async (tx) => {
    const locked = await tx.execute(
      sql`SELECT trust_score, trust_tier, is_under_review FROM users WHERE user_id = ${user_id} FOR UPDATE`,
    );
    const current = locked.rows[0] as { trust_score: number; trust_tier: string; is_under_review: boolean } | undefined;
    if (!current) return;

    const oldScore = current.trust_score;
    const oldTier = current.trust_tier;

    if (oldScore !== newScore || oldTier !== newTier) {
      await tx.update(users).set({ trustScore: newScore, trustTier: newTier, updatedAt: sql`now()` }).where(eq(users.userId, user_id));
      await tx.insert(trustScoreHistory).values({
        userId: user_id,
        oldScore,
        newScore,
        oldTier: oldTier as typeof newTier,
        newTier,
        reason,
      });
    }

    const scoreDrop = newScore < REVIEW_THRESHOLD && oldScore >= REVIEW_THRESHOLD;
    const mlOverride = mlDelta?.override_review ?? false;
    if (!current.is_under_review && (scoreDrop || mlOverride)) {
      const reviewReason =
        mlOverride && mlDelta
          ? `ML flagged as "${mlDelta.persona_prediction}" (confidence ${(mlDelta.confidence * 100).toFixed(0)}%). ${(mlDelta.ml_flags ?? []).slice(0, 2).join(' ')}`.trim()
          : `Score dropped to ${newScore} — abnormal pattern detected.`;
      await tx
        .update(users)
        .set({ isUnderReview: true, reviewReason, reviewStartedAt: sql`now()`, updatedAt: sql`now()` })
        .where(eq(users.userId, user_id));
      logger.warn(LOG, 'account flagged for review', { userId: user_id, newScore, scoreDrop, mlOverride });
    }
  });

  await cacheDel(keys.trustScore(user_id)).catch(() => {});
};

export const trustRecompute: JobDescriptor<'trust-recompute'> = { name: 'trust-recompute', process, concurrency: 5 };
