/**
 * worker/src/jobs/mlFeedback.ts
 *
 * Automatic ML feedback trigger.
 *
 * The ML models improve over time only if they receive confirmed ground-truth
 * labels. Manual admin feedback is the primary source, but this job provides
 * an automated supplement by detecting high-confidence bad actors from
 * observable signals:
 *
 *   Trigger: a user who has been blocked by ≥ 10 DIFFERENT users within
 *   7 days AND has not yet had a feedback signal sent this week.
 *
 * For each candidate:
 *   1. Extract their features from the DB
 *   2. Send a 'spammer' label to the ML service's /retrain-signal endpoint
 *   3. Record a behavior event so the same user is not re-submitted this week
 *
 * This job runs every 6 hours (wired in index.ts).
 * Concurrency: 1 — the feature extraction is DB-intensive.
 *
 * False-positive mitigation:
 *   • The 10-unique-blocker threshold is high enough to avoid triggering on
 *     personal disputes (where one person might have many accounts).
 *   • We only submit to ML (not auto-suspend) — the actual label is advisory.
 *   • An admin still needs to review and suspend if warranted.
 */

import { Worker, Job } from 'bullmq';
import { query, queryOne, getRedis, keys } from '@trustroute/shared';
import type { MLFeedbackJob } from '../queues';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';
import { scoreByUserId } from '../utils/mlClient';

const JOB = 'ml-feedback';
const BLOCK_THRESHOLD  = 10;    // unique blockers required
const WINDOW_DAYS      = 7;     // look-back window
const FEEDBACK_TTL_S   = 7 * 24 * 60 * 60;  // 7 days, same as window

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function runAutoMLFeedback(): Promise<{ processed: number; skipped: number }> {
  const ML_BASE = process.env.ML_SERVICE_URL ?? 'http://localhost:8001';
  const ML_KEY  = process.env.ML_API_KEY     ?? 'trustroute-ml-dev-key';
  const redis   = getRedis();

  // Find users with ≥ BLOCK_THRESHOLD unique recent blockers.
  // Monitored users (set by admin 'monitor' action) use a lower threshold of 5
  // so they get caught sooner if their behaviour worsens after review.
  const candidates = await query<{
    user_id: string; unique_blockers: string; trust_score: number; is_monitored: boolean;
  }>(
    `SELECT c.contact_id AS user_id,
            COUNT(DISTINCT c.owner_id)::text AS unique_blockers,
            u.trust_score,
            u.is_monitored
       FROM connections c
       JOIN users u ON u.user_id = c.contact_id
      WHERE c.connection_type = 'blocked'
        AND c.updated_at > NOW() - ($1 || ' days')::INTERVAL
        AND u.is_active = TRUE
        AND u.is_under_review = FALSE   -- already being reviewed; skip
      GROUP BY c.contact_id, u.trust_score, u.is_monitored
      HAVING COUNT(DISTINCT c.owner_id) >= CASE WHEN u.is_monitored THEN 5 ELSE $2 END`,
    [WINDOW_DAYS, BLOCK_THRESHOLD],
  );

  let processed = 0;
  let skipped   = 0;

  for (const candidate of candidates) {
    const feedbackKey = keys.mlFeedbackSent(candidate.user_id);

    // Skip if we already sent feedback for this user this week (Redis gate)
    const alreadySent = await redis.get(feedbackKey);
    if (alreadySent) {
      skipped++;
      continue;
    }

    try {
      // Build a minimal feature payload from available data
      const mlScore = await scoreByUserId(candidate.user_id);
      const predictedLabel = mlScore?.persona_prediction ?? 'suspicious';

      // Send to ML service /retrain-signal
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 5_000);

      const resp = await fetch(`${ML_BASE}/retrain-signal`, {
        method:  'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-API-Key':    ML_KEY,
        },
        body: JSON.stringify({
          user_id:         candidate.user_id,
          true_label:      'spammer',
          predicted_label: predictedLabel,
          features: {
            trust_score:     candidate.trust_score,
            blocked_by_7d:   parseInt(candidate.unique_blockers),
            trigger:         'auto_block_threshold',
          },
        }),
        signal: controller.signal,
      });

      clearTimeout(timer);

      if (!resp.ok) {
        logger.warn(JOB, 'ML retrain-signal rejected', {
          user_id: candidate.user_id,
          status: resp.status,
        });
        skipped++;
        continue;
      }

      // Record the feedback event in PostgreSQL (audit trail)
      await query(
        `INSERT INTO behavior_events (user_id, event_type, metadata)
         VALUES ($1, 'ml_feedback_auto_sent', $2)`,
        [
          candidate.user_id,
          JSON.stringify({
            trigger:         'auto_block_threshold',
            unique_blockers: parseInt(candidate.unique_blockers),
            predicted_label: predictedLabel,
          }),
        ],
      );

      // Set Redis gate so this user isn't submitted again for 7 days
      await redis.set(feedbackKey, '1', 'EX', FEEDBACK_TTL_S);

      logger.info(JOB, 'Auto feedback sent', {
        user_id:         candidate.user_id,
        unique_blockers: candidate.unique_blockers,
        trust_score:     candidate.trust_score,
      });

      processed++;
    } catch (err: any) {
      logger.warn(JOB, 'Failed to send auto feedback', {
        user_id: candidate.user_id,
        error:   err.message,
      });
      skipped++;
    }
  }

  return { processed, skipped };
}

// ─── BullMQ worker ────────────────────────────────────────────────────────────

export function startMLFeedbackWorker() {
  const worker = new Worker<MLFeedbackJob>(
    JOB,
    async (_job: Job<MLFeedbackJob>) => {
      const result = await runAutoMLFeedback();
      if (result.processed > 0) {
        logger.info(JOB, 'Scan complete', result);
      }
    },
    {
      connection:  getBullRedis(),
      concurrency: 1,
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

export async function enqueueMLFeedbackScan() {
  const { mlFeedbackQueue } = await import('../queues');
  const jobId = `ml-feedback-${Math.floor(Date.now() / (6 * 60 * 60 * 1_000))}`; // dedupe per 6h
  await mlFeedbackQueue.add(
    'scan',
    {},
    { jobId, removeOnComplete: true, removeOnFail: { count: 10 } },
  );
}
