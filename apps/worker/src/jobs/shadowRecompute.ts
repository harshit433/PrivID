/**
 * Shadow-trust recompute (nightly). Aggregates the last 180 days of dialer_observations
 * into per-phone-hash reputation rows. Only hashes with observations newer than their
 * last computed row are touched, so the batch stays cheap as volume grows. A single
 * upsert does the whole job — no N+1.
 *
 *   shadow_score = clamp(50 + 25·pick + 30·save − 50·block − 20·decline − 15·hungFast, 0, 100)
 *   applied only when observation_count ≥ 5 (fewer ⇒ neutral 50).
 */
import { db, sql, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const WINDOW_DAYS = 180;
const MIN_OBSERVATIONS = 5;

const process: Processor<JobMap['shadow-recompute']> = async () => {
  const t0 = Date.now();
  const res = await db.execute(sql`
    WITH aggregated AS (
      SELECT
        o.phone_hash,
        COUNT(*)::int AS obs_count,
        COALESCE(SUM(o.weight), 0)::numeric AS weight_total,
        COALESCE(SUM(o.weight) FILTER (WHERE o.outcome IN ('picked_up','incoming_accepted','outgoing_answered')), 0)::numeric AS picked_up,
        COALESCE(SUM(o.weight) FILTER (WHERE o.outcome IN ('declined','incoming_declined','outgoing_declined','incoming_missed','outgoing_missed')), 0)::numeric AS declined,
        COALESCE(SUM(o.weight) FILTER (WHERE o.outcome IN ('blocked','incoming_blocked')), 0)::numeric AS blocked,
        COALESCE(SUM(o.weight) FILTER (WHERE o.outcome = 'saved'), 0)::numeric AS saved,
        COALESCE(SUM(o.weight) FILTER (WHERE o.outcome = 'hung_up_fast'), 0)::numeric AS hung_fast
      FROM dialer_observations o
      WHERE o.observed_at > NOW() - (${WINDOW_DAYS} || ' days')::INTERVAL
        AND o.weight > 0
        AND (
          NOT EXISTS (SELECT 1 FROM shadow_numbers sn WHERE sn.phone_hash = o.phone_hash AND sn.last_updated_at > o.observed_at)
          OR NOT EXISTS (SELECT 1 FROM shadow_numbers sn WHERE sn.phone_hash = o.phone_hash)
        )
      GROUP BY o.phone_hash
    ),
    scored AS (
      SELECT
        phone_hash,
        obs_count,
        CASE WHEN weight_total > 0 THEN ROUND(picked_up / weight_total, 4) ELSE 0 END AS pick_rate,
        CASE WHEN weight_total > 0 THEN ROUND(declined  / weight_total, 4) ELSE 0 END AS declined_rate,
        CASE WHEN weight_total > 0 THEN ROUND(blocked   / weight_total, 4) ELSE 0 END AS block_rate,
        CASE WHEN weight_total > 0 THEN ROUND(saved     / weight_total, 4) ELSE 0 END AS save_rate,
        CASE WHEN weight_total > 0 THEN ROUND(hung_fast / weight_total, 4) ELSE 0 END AS hung_fast_rate,
        CASE
          WHEN obs_count < ${MIN_OBSERVATIONS} THEN 50
          ELSE GREATEST(0, LEAST(100, ROUND(
            50
            + 25 * (CASE WHEN weight_total > 0 THEN picked_up / weight_total ELSE 0 END)
            + 30 * (CASE WHEN weight_total > 0 THEN saved     / weight_total ELSE 0 END)
            - 50 * (CASE WHEN weight_total > 0 THEN blocked   / weight_total ELSE 0 END)
            - 20 * (CASE WHEN weight_total > 0 THEN declined  / weight_total ELSE 0 END)
            - 15 * (CASE WHEN weight_total > 0 THEN hung_fast / weight_total ELSE 0 END)
          )))
        END AS shadow_score
      FROM aggregated
    )
    INSERT INTO shadow_numbers
      (phone_hash, pick_rate, declined_rate, block_rate, save_rate, hung_fast_rate, observation_count, shadow_score, last_updated_at)
    SELECT phone_hash, pick_rate, declined_rate, block_rate, save_rate, hung_fast_rate, obs_count, shadow_score, NOW()
    FROM scored
    ON CONFLICT (phone_hash) DO UPDATE SET
      pick_rate = EXCLUDED.pick_rate,
      declined_rate = EXCLUDED.declined_rate,
      block_rate = EXCLUDED.block_rate,
      save_rate = EXCLUDED.save_rate,
      hung_fast_rate = EXCLUDED.hung_fast_rate,
      observation_count = EXCLUDED.observation_count,
      shadow_score = EXCLUDED.shadow_score,
      last_updated_at = NOW()
    RETURNING phone_hash
  `);
  logger.info('worker:shadow-recompute', 'complete', { updated: res.rows.length, durationMs: Date.now() - t0 });
};

export const shadowRecompute: JobDescriptor<'shadow-recompute'> = { name: 'shadow-recompute', process, concurrency: 1 };
