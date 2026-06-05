/**
 * worker/src/jobs/shadowScoreRecompute.ts
 *
 * Nightly job that aggregates dialer_observations into shadow_numbers.
 *
 * Algorithm per phone_hash (using last 180 days of observations):
 *
 *   pick_rate      = picked_up / total
 *   declined_rate  = declined   / total
 *   block_rate     = blocked    / total
 *   save_rate      = saved      / total
 *   hung_fast_rate = hung_up_fast / total
 *
 *   shadow_score =
 *     CLAMP(
 *       50
 *       + 25 × pick_rate
 *       + 30 × save_rate
 *       − 50 × block_rate
 *       − 15 × hung_fast_rate,
 *       0, 100
 *     )
 *
 *   Applied only if observation_count ≥ 5 (fewer = neutral 50).
 *
 * Performance:
 *   Operates only on phone hashes that have new observations since the last
 *   shadow_numbers.last_updated_at to keep the nightly job fast even as
 *   observation volume grows.  For 1 000 TrustRoute users observing ~ 100
 *   numbers each, the incremental update set is small.
 *
 *   Uses a single aggregation SQL to avoid N+1 queries.
 */

import { Worker, Job } from 'bullmq';
import { query } from '@trustroute/shared';
import type { ShadowRecomputeJob } from '../queues';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';

const JOB = 'shadow-recompute';
const OBSERVATION_WINDOW_DAYS = 180;
const MIN_OBSERVATIONS = 5;

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function recomputeShadowScores(): Promise<number> {
  // Single SQL: aggregate all hashes that have new observations since their
  // last_updated_at (or have never been computed).
  const upserted = await query<{ phone_hash: string; new_score: number }>(
    `WITH aggregated AS (
       SELECT
         o.phone_hash,
         COUNT(*)::int                                                       AS obs_count,
         COALESCE(SUM(o.weight), 0)                                        AS weight_total,
         COALESCE(SUM(o.weight) FILTER (WHERE o.outcome IN (
           'picked_up', 'incoming_accepted', 'outgoing_answered'
         )), 0)::numeric                                                   AS picked_up,
         COALESCE(SUM(o.weight) FILTER (WHERE o.outcome IN (
           'declined', 'incoming_declined', 'outgoing_declined',
           'incoming_missed', 'outgoing_missed'
         )), 0)::numeric                                                   AS declined,
         COALESCE(SUM(o.weight) FILTER (WHERE o.outcome IN (
           'blocked', 'incoming_blocked'
         )), 0)::numeric                                                   AS blocked,
         COALESCE(SUM(o.weight) FILTER (WHERE o.outcome = 'saved'), 0)::numeric AS saved,
         COALESCE(SUM(o.weight) FILTER (WHERE o.outcome = 'hung_up_fast'), 0)::numeric AS hung_fast
       FROM dialer_observations o
       WHERE o.observed_at > NOW() - ($1 || ' days')::INTERVAL
         AND o.weight > 0
         AND (
           -- Only recompute hashes with activity since last update
           NOT EXISTS (
             SELECT 1 FROM shadow_numbers sn
             WHERE sn.phone_hash = o.phone_hash
               AND sn.last_updated_at > o.observed_at
           )
           OR NOT EXISTS (SELECT 1 FROM shadow_numbers sn WHERE sn.phone_hash = o.phone_hash)
         )
       GROUP BY o.phone_hash
     ),
     scored AS (
       SELECT
         phone_hash,
         obs_count,
         weight_total,
         CASE WHEN weight_total > 0 THEN ROUND(picked_up  / weight_total, 4) ELSE 0 END AS pick_rate,
         CASE WHEN weight_total > 0 THEN ROUND(declined    / weight_total, 4) ELSE 0 END AS declined_rate,
         CASE WHEN weight_total > 0 THEN ROUND(blocked     / weight_total, 4) ELSE 0 END AS block_rate,
         CASE WHEN weight_total > 0 THEN ROUND(saved       / weight_total, 4) ELSE 0 END AS save_rate,
         CASE WHEN weight_total > 0 THEN ROUND(hung_fast   / weight_total, 4) ELSE 0 END AS hung_fast_rate,
         CASE
           WHEN obs_count < $2 THEN 50
           ELSE GREATEST(0, LEAST(100, ROUND(
             50
             + 25 * (CASE WHEN weight_total > 0 THEN picked_up  / weight_total ELSE 0 END)
             + 30 * (CASE WHEN weight_total > 0 THEN saved       / weight_total ELSE 0 END)
             - 50 * (CASE WHEN weight_total > 0 THEN blocked     / weight_total ELSE 0 END)
             - 20 * (CASE WHEN weight_total > 0 THEN declined    / weight_total ELSE 0 END)
             - 15 * (CASE WHEN weight_total > 0 THEN hung_fast   / weight_total ELSE 0 END)
           )))
         END AS shadow_score
       FROM aggregated
     )
     INSERT INTO shadow_numbers
            (phone_hash, pick_rate, declined_rate, block_rate, save_rate,
             hung_fast_rate, observation_count, shadow_score, last_updated_at)
     SELECT phone_hash, pick_rate, declined_rate, block_rate, save_rate,
            hung_fast_rate, obs_count, shadow_score, NOW()
     FROM scored
     ON CONFLICT (phone_hash) DO UPDATE
       SET pick_rate         = EXCLUDED.pick_rate,
           declined_rate     = EXCLUDED.declined_rate,
           block_rate        = EXCLUDED.block_rate,
           save_rate         = EXCLUDED.save_rate,
           hung_fast_rate    = EXCLUDED.hung_fast_rate,
           observation_count = EXCLUDED.observation_count,
           shadow_score      = EXCLUDED.shadow_score,
           last_updated_at   = NOW()
     RETURNING phone_hash, shadow_score AS new_score`,
    [OBSERVATION_WINDOW_DAYS, MIN_OBSERVATIONS],
  );

  return upserted.length;
}

// ─── BullMQ worker ────────────────────────────────────────────────────────────

export function startShadowScoreRecomputeWorker() {
  const worker = new Worker<ShadowRecomputeJob>(
    JOB,
    async (_job: Job<ShadowRecomputeJob>) => {
      logger.info(JOB, 'Starting shadow score recompute');
      const t0 = Date.now();

      const count = await recomputeShadowScores();

      logger.info(JOB, 'Shadow recompute complete', {
        updated: count,
        duration_ms: Date.now() - t0,
      });
    },
    {
      connection:  getBullRedis(),
      concurrency: 1,  // single batch SQL — parallelism adds no benefit
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(JOB, 'Job failed', { job_id: job?.id, error: err.message });
  });

  worker.on('error', (err) => {
    logger.error(JOB, 'Worker error', { error: err.message });
  });

  logger.info(JOB, 'Worker started');
  return worker;
}

// ─── Enqueue helper ───────────────────────────────────────────────────────────

export async function enqueueShadowRecompute() {
  const { shadowRecomputeQueue } = await import('../queues');
  // Stable daily jobId so rapid cron ticks don't pile up
  const jobId = `shadow-${new Date().toISOString().slice(0, 10)}`;
  await shadowRecomputeQueue.add(
    'nightly',
    {},
    { jobId, removeOnComplete: true, removeOnFail: { count: 7 } },
  );
}
