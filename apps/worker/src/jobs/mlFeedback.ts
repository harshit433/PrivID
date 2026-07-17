/**
 * Auto ML-feedback (every 6h). Supplies the ML models with ground-truth "spammer" labels
 * inferred from strong observable signals: a user blocked by ≥10 distinct users in 7 days
 * (≥5 if already flagged for monitoring). For each candidate we send a retrain signal and
 * gate re-submission for a week. Entirely optional — when ML is unconfigured every send
 * fails open and the job is a no-op. Advisory only: it never suspends; an admin still acts.
 */
import { db, sql, acquireGate, keys, config, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';
import { scoreByUserId, sendRetrainSignal } from '../lib/mlClient';

const WINDOW_DAYS = 7;
const BLOCK_THRESHOLD = 10;
const GATE_TTL_S = 7 * 24 * 60 * 60;

const process: Processor<JobMap['ml-feedback']> = async () => {
  if (!config.ML_SERVICE_URL) return; // ML disabled — nothing to feed

  const candidates = await db.execute(sql`
    SELECT c.contact_id AS user_id,
           COUNT(DISTINCT c.owner_id)::int AS unique_blockers,
           u.trust_score,
           u.is_monitored
    FROM connections c JOIN users u ON u.user_id = c.contact_id
    WHERE c.connection_type = 'blocked'
      AND c.updated_at > now() - (${WINDOW_DAYS} || ' days')::INTERVAL
      AND u.is_active = TRUE AND u.is_under_review = FALSE AND u.handle NOT LIKE 'tsim_%'
    GROUP BY c.contact_id, u.trust_score, u.is_monitored
    HAVING COUNT(DISTINCT c.owner_id) >= CASE WHEN u.is_monitored THEN 5 ELSE ${BLOCK_THRESHOLD} END
  `);

  let processed = 0;
  for (const row of candidates.rows as Array<{ user_id: string; unique_blockers: number; trust_score: number }>) {
    // Weekly dedupe gate; acquireGate returns false if already sent this window.
    if (!(await acquireGate(keys.mlFeedbackSent(row.user_id), GATE_TTL_S))) continue;
    const ml = await scoreByUserId(row.user_id);
    const sent = await sendRetrainSignal({
      userId: row.user_id,
      trueLabel: 'spammer',
      predictedLabel: ml?.persona_prediction ?? 'suspicious',
      features: { trust_score: row.trust_score, blocked_by_7d: Number(row.unique_blockers), trigger: 'auto_block_threshold' },
    });
    if (sent) processed++;
  }
  if (processed) logger.info('worker:ml-feedback', 'signals sent', { processed });
};

export const mlFeedback: JobDescriptor<'ml-feedback'> = { name: 'ml-feedback', process, concurrency: 1 };
