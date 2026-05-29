import { Worker, Job } from 'bullmq';
import { query } from '@privid/shared';
import type { MassOutreachJob } from '../queues';
import { trustRecomputeQueue } from '../queues';
import { getBullRedis } from '../redis';

/**
 * Mass Outreach Detection
 *
 * Thresholds (per 60 min window):
 *   - calls to >15 unique users  → flag
 *   - >20 total call attempts    → flag
 *   - decline rate >70%          → flag
 *
 * On flag: insert behavior_events row with type 'mass_outreach_flag'
 *          then trigger trust recompute (which applies the penalty)
 */
export function startMassOutreachWorker() {
  const worker = new Worker<MassOutreachJob>(
    'mass-outreach',
    async (job: Job<MassOutreachJob>) => {
      const { user_id } = job.data;

      const [stats] = await query<{
        unique_callees: string;
        total_calls: string;
        declined: string;
      }>(
        `SELECT
           COUNT(DISTINCT callee_id)::text AS unique_callees,
           COUNT(*)::text AS total_calls,
           COUNT(*) FILTER (WHERE status = 'declined')::text AS declined
         FROM calls
         WHERE caller_id = $1
           AND created_at > NOW() - INTERVAL '60 minutes'`,
        [user_id]
      );

      const uniqueCallees = parseInt(stats.unique_callees);
      const totalCalls    = parseInt(stats.total_calls);
      const declined      = parseInt(stats.declined);
      const declineRate   = totalCalls >= 5 ? declined / totalCalls : 0;

      const flagged =
        uniqueCallees > 15 ||
        totalCalls > 20 ||
        declineRate > 0.7;

      if (flagged) {
        console.warn(`[mass-outreach] Flagging user ${user_id}: ` +
          `uniqueCallees=${uniqueCallees}, total=${totalCalls}, declineRate=${(declineRate * 100).toFixed(0)}%`);

        await query(
          `INSERT INTO behavior_events (user_id, event_type, metadata)
           VALUES ($1, 'mass_outreach_flag', $2)`,
          [user_id, JSON.stringify({ uniqueCallees, totalCalls, declineRate })]
        );

        // Trigger trust recompute to apply penalty
        await trustRecomputeQueue.add(
          'recompute',
          { user_id, reason: 'mass_outreach_flag' },
          { priority: 1 }
        );
      }
    },
    { connection: getBullRedis(), concurrency: 10 }
  );

  worker.on('failed', (job, err) => {
    console.error(`[mass-outreach] Job ${job?.id} failed:`, err.message);
  });

  return worker;
}

/**
 * Scheduled scanner — enqueues a mass outreach check for every user
 * who initiated calls in the last 90 minutes.
 * Called by a cron (see index.ts).
 */
export async function enqueueMassOutreachScan() {
  const activeCallers = await query<{ caller_id: string }>(
    `SELECT DISTINCT caller_id FROM calls
     WHERE created_at > NOW() - INTERVAL '90 minutes'`
  );

  for (const { caller_id } of activeCallers) {
    await (await import('../queues')).massOutreachQueue.add(
      'check',
      { user_id: caller_id },
      { jobId: `outreach-${caller_id}-${Math.floor(Date.now() / 60000)}`, removeOnComplete: true }
    );
  }
  console.log(`[mass-outreach] Enqueued checks for ${activeCallers.length} users`);
}
