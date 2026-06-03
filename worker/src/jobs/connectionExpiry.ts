/**
 * worker/src/jobs/connectionExpiry.ts
 *
 * Downgrades Temporary connections whose window has elapsed back to Unknown.
 *
 * Without this job, a connection set to Temporary-7-days would stay Temporary
 * forever — the core product promise ("access expires automatically") would be
 * silently broken.
 *
 * What the job does:
 *   1. Find all connections WHERE type = 'temporary' AND expires_at < NOW()
 *   2. Downgrade each to 'unknown', clear expires_at
 *   3. Log the downgrade to behavior_events (both parties notified)
 *   4. Enqueue a trust recompute for the contact (losing a temp slot affects score)
 *
 * Schedule: every 10 minutes via setInterval in index.ts.
 * Concurrency: 1 (scan is a single SQL batch, no benefit from parallelism).
 *
 * Idempotent: re-running on already-downgraded rows is a no-op because the
 * WHERE clause filters on connection_type = 'temporary'.
 */

import { Worker, Job } from 'bullmq';
import { query, withTransaction } from '@trustroute/shared';
import type { ConnectionExpiryJob } from '../queues';
import { getBullRedis } from '../redis';
import { logger } from '../utils/logger';
import { enqueueTrustRecompute } from './trustRecompute';

const JOB = 'connection-expiry';

interface ExpiredRow {
  connection_id: string;
  owner_id:      string;
  contact_id:    string;
  contact_name:  string | null;
}

// ─── Core logic ───────────────────────────────────────────────────────────────

export async function expireConnections(): Promise<number> {
  // Fetch and downgrade in a single transaction to avoid partial updates.
  // The UPDATE … RETURNING gives us the affected rows for follow-up work.
  let expired: ExpiredRow[] = [];

  await withTransaction(async (client) => {
    const { rows } = await client.query<ExpiredRow>(
      `UPDATE connections
          SET connection_type      = 'unknown',
              temporary_expires_at = NULL,
              updated_at           = NOW()
        WHERE connection_type      = 'temporary'
          AND temporary_expires_at < NOW()
        RETURNING connection_id, owner_id, contact_id, contact_name`,
    );
    expired = rows;
  });

  if (expired.length === 0) return 0;

  logger.info(JOB, 'Downgraded expired temporary connections', {
    count: expired.length,
  });

  // ── Post-downgrade side-effects (best-effort, don't fail the job) ──────────
  const sideEffects = expired.map(async (row) => {
    try {
      // 1. Record behavior events for both sides so the audit log is complete.
      await query(
        `INSERT INTO behavior_events (user_id, event_type, target_user_id, metadata)
         VALUES
           ($1, 'connection_expired', $2, $3),
           ($2, 'connection_expired', $1, $3)
         ON CONFLICT DO NOTHING`,
        [
          row.owner_id,
          row.contact_id,
          JSON.stringify({ connection_id: row.connection_id, reason: 'temporary_window_elapsed' }),
        ],
      );

      // 2. Enqueue trust recompute for the contact (they lost a temporary relationship).
      //    Low priority (4) so it doesn't jump the queue ahead of real-time events.
      await enqueueTrustRecompute(
        row.contact_id,
        'temporary_connection_expired',
        { priority: 4 },
      );
    } catch (err: any) {
      // Non-fatal — the downgrade already persisted.
      logger.warn(JOB, 'Side-effect failed for connection', {
        connection_id: row.connection_id,
        error: err.message,
      });
    }
  });

  await Promise.allSettled(sideEffects);

  return expired.length;
}

// ─── BullMQ worker ────────────────────────────────────────────────────────────

export function startConnectionExpiryWorker() {
  const worker = new Worker<ConnectionExpiryJob>(
    JOB,
    async (_job: Job<ConnectionExpiryJob>) => {
      const count = await expireConnections();
      if (count > 0) {
        logger.info(JOB, 'Scan complete', { expired: count });
      }
    },
    {
      connection:  getBullRedis(),
      concurrency: 1,   // single scan process, no parallel benefit
    },
  );

  worker.on('failed', (job, err) => {
    logger.error(JOB, 'Job failed', {
      job_id: job?.id,
      error:  err.message,
    });
  });

  worker.on('error', (err) => {
    logger.error(JOB, 'Worker error', { error: err.message });
  });

  logger.info(JOB, 'Worker started');
  return worker;
}

// ─── Enqueue helper (called from index.ts on cron tick) ──────────────────────

export async function enqueueConnectionExpiryScan() {
  const { connectionExpiryQueue } = await import('../queues');
  // Use a stable jobId so rapid cron ticks don't pile up duplicate scans.
  const jobId = `connection-expiry-${Math.floor(Date.now() / 60_000)}`; // dedupe per minute
  await connectionExpiryQueue.add(
    'scan',
    {},
    {
      jobId,
      removeOnComplete: true,
      removeOnFail:     { count: 10 },
    },
  );
}
