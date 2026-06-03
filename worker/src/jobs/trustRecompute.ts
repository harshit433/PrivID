/**
 * worker/src/jobs/trustRecompute.ts — v2
 *
 * Replaces the old hand-rolled scoring logic with:
 *   1. computeVerificationPoints()  — from @trustroute/shared (same code the API uses)
 *   2. scoreByUserId()              — ML service via HTTP (same delta the API fetches)
 *
 * This guarantees the worker and the API always produce identical scores for
 * the same user state.  Previously the worker had its own divergent formula
 * that included a "network_trust" factor and rule-based block penalties that
 * the API had already retired.
 *
 * Concurrency: up to 5 jobs in parallel (sufficient for 1 000 users).
 * The ML service timeout is 5 s; verification SQL is a fast indexed read.
 * Expected p95 job duration: ~300 ms on a warm ML service.
 *
 * Fail-open: if the ML service is unavailable the job still persists the
 * verification-only score (ml_modifier = 0) rather than failing the job.
 */

import { Worker, Job } from 'bullmq';
import {
  withTransaction,
  computeVerificationPoints,
  scoreToTier,
  clampScore,
} from '@trustroute/shared';
import type { UserRow, TrustTier } from '@trustroute/shared';
import type { TrustRecomputeJob } from '../queues';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';
import { scoreByUserId } from '../utils/mlClient';

const JOB = 'trust-recompute';

// ─── Core logic (exported for unit testing) ───────────────────────────────────

export interface RecomputeResult {
  user_id:          string;
  old_score:        number;
  new_score:        number;
  old_tier:         TrustTier;
  new_tier:         TrustTier;
  ml_used:          boolean;
  review_triggered: boolean;
}

export async function recomputeUser(
  userId: string,
  reason: string,
): Promise<RecomputeResult | null> {

  // ── 1. Fetch verification points + ML delta in parallel ──────────────────
  const [verif, mlDelta] = await Promise.all([
    computeVerificationPoints(userId),
    scoreByUserId(userId),
  ]);

  const mlModifier = mlDelta?.ml_score_delta ?? 0;
  const newScore   = clampScore(verif.total + mlModifier);
  const newTier    = scoreToTier(newScore);
  const mlUsed     = mlDelta !== null;

  if (!mlUsed) {
    logger.warn(JOB, 'ML unavailable — applying verification-only score', {
      userId,
      verif_pts: verif.total,
    });
  }

  // ── 2. Persist inside a serialisable transaction ─────────────────────────
  let result: RecomputeResult | null = null;

  await withTransaction(async (client) => {
    const { rows } = await client.query<
      Pick<UserRow, 'trust_score' | 'trust_tier' | 'is_under_review'>
    >(
      `SELECT trust_score, trust_tier, is_under_review
         FROM users
        WHERE user_id = $1
        FOR UPDATE`,
      [userId],
    );

    const current = rows[0];
    if (!current) {
      logger.warn(JOB, 'User not found — skipping', { userId });
      return;
    }

    const oldScore = current.trust_score;
    const oldTier  = current.trust_tier as TrustTier;

    // Only write if the score changed (avoids bloating trust_score_history)
    if (oldScore !== newScore || oldTier !== newTier) {
      await client.query(
        `UPDATE users
            SET trust_score = $1,
                trust_tier  = $2,
                updated_at  = NOW()
          WHERE user_id = $3`,
        [newScore, newTier, userId],
      );

      await client.query(
        `INSERT INTO trust_score_history
               (user_id, old_score, new_score, old_tier, new_tier, reason)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [userId, oldScore, newScore, oldTier, newTier, reason],
      );
    }

    // ── 3. Auto-review triggers ──────────────────────────────────────────────
    const mlOverride  = mlDelta?.override_review ?? false;
    const scoreDrop   = newScore < 20 && oldScore >= 20;
    const needsReview = !current.is_under_review && (mlOverride || scoreDrop);

    if (needsReview) {
      const reviewReason = mlOverride && mlDelta
        ? `ML flagged as "${mlDelta.persona_prediction}" ` +
          `(confidence ${(mlDelta.confidence * 100).toFixed(0)}%). ` +
          (mlDelta.ml_flags ?? []).slice(0, 2).join(' ')
        : `Score dropped to ${newScore} — abnormal pattern detected.`;

      await client.query(
        `UPDATE users
            SET is_under_review   = TRUE,
                review_reason     = $1,
                review_started_at = NOW()
          WHERE user_id = $2`,
        [reviewReason, userId],
      );

      logger.warn(JOB, 'Account flagged for review', {
        userId,
        reviewReason,
        newScore,
        mlOverride,
        scoreDrop,
      });
    }

    result = {
      user_id:          userId,
      old_score:        oldScore,
      new_score:        newScore,
      old_tier:         oldTier,
      new_tier:         newTier,
      ml_used:          mlUsed,
      review_triggered: needsReview,
    };
  });

  return result;
}

// ─── BullMQ worker ────────────────────────────────────────────────────────────

export function startTrustRecomputeWorker() {
  const worker = new Worker<TrustRecomputeJob>(
    JOB,
    async (job: Job<TrustRecomputeJob>) => {
      const { user_id, reason } = job.data;

      logger.info(JOB, 'Processing job', {
        user_id,
        reason,
        attempt: job.attemptsMade + 1,
      });

      const result = await recomputeUser(user_id, reason);

      if (result) {
        const changed =
          result.old_score !== result.new_score ||
          result.old_tier  !== result.new_tier;

        logger.info(JOB, changed ? 'Score updated' : 'No change', {
          user_id,
          old:     `${result.old_score} (${result.old_tier})`,
          new:     `${result.new_score} (${result.new_tier})`,
          ml_used: result.ml_used,
          review:  result.review_triggered,
        });
      }
    },
    {
      connection:  getBullRedis(),
      concurrency: 5,
      limiter:     { max: 50, duration: 1_000 },
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(JOB, 'Job failed', {
      job_id:  job?.id,
      user_id: job?.data?.user_id,
      attempt: job?.attemptsMade,
      error:   err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(JOB, 'Worker error', { error: err.message });
  });

  logger.info(JOB, 'Worker started', { concurrency: 5 });
  return worker;
}

// ─── Queue helper (called from API after trust-affecting events) ──────────────

export async function enqueueTrustRecompute(
  userId: string,
  reason: string,
  opts: { priority?: number; delay?: number } = {},
) {
  const { trustRecomputeQueue } = await import('../queues');
  await trustRecomputeQueue.add(
    reason,
    { user_id: userId, reason },
    {
      jobId:            `trust-${userId}-${Date.now()}`,
      removeOnComplete: { count: 200 },
      removeOnFail:     { count: 50 },
      attempts:         3,
      backoff:          { type: 'exponential', delay: 2_000 },
      priority:         opts.priority,
      delay:            opts.delay,
    },
  );
}
