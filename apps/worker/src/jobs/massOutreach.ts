/**
 * Mass-outreach detection. The scheduler's scan enqueues one check per user who placed
 * calls in the last 90 min; each check looks at that user's last 60 min of calls and
 * flags spam-like fan-out (>15 unique callees, >20 attempts, or >70% declines). A flag
 * writes a behavior_event and triggers a trust recompute (which applies the penalty).
 * Simulation handles (`tsim_`) are excluded at both scan and check.
 */
import { db, calls, behaviorEvents, users, sql, enqueue, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const process: Processor<JobMap['mass-outreach']> = async (job) => {
  const { user_id } = job.data;

  const [guard] = await db.select({ handle: users.handle }).from(users).where(sql`${users.userId} = ${user_id}`).limit(1);
  if (!guard || guard.handle.startsWith('tsim_')) return;

  const stats = await db.execute(sql`
    SELECT COUNT(DISTINCT callee_id)::int AS unique_callees,
           COUNT(*)::int AS total_calls,
           COUNT(*) FILTER (WHERE status = 'declined')::int AS declined
    FROM ${calls}
    WHERE caller_id = ${user_id} AND created_at > now() - INTERVAL '60 minutes'
  `);
  const row = stats.rows[0] as { unique_callees: number; total_calls: number; declined: number };
  const uniqueCallees = Number(row.unique_callees);
  const totalCalls = Number(row.total_calls);
  const declineRate = totalCalls >= 5 ? Number(row.declined) / totalCalls : 0;

  if (uniqueCallees > 15 || totalCalls > 20 || declineRate > 0.7) {
    logger.warn('worker:mass-outreach', 'flagging user', { userId: user_id, uniqueCallees, totalCalls, declineRate });
    await db.insert(behaviorEvents).values({ userId: user_id, eventType: 'mass_outreach_flag', metadata: { uniqueCallees, totalCalls, declineRate } });
    await enqueue('trust-recompute', { user_id, reason: 'mass_outreach_flag' }, { jobId: `trust-${user_id}-outreach` });
  }
};

/** Scheduler scan: enqueue a check for every non-sim user who called in the last 90 min. */
export async function enqueueMassOutreachScan(): Promise<void> {
  const active = await db.execute(sql`
    SELECT DISTINCT c.caller_id
    FROM ${calls} c JOIN ${users} u ON u.user_id = c.caller_id
    WHERE c.created_at > now() - INTERVAL '90 minutes' AND u.handle NOT LIKE 'tsim_%'
  `);
  const bucket = Math.floor(Date.now() / 60_000);
  for (const r of active.rows as Array<{ caller_id: string }>) {
    await enqueue('mass-outreach', { user_id: r.caller_id }, { jobId: `outreach-${r.caller_id}-${bucket}` });
  }
  if (active.rows.length) logger.info('worker:mass-outreach', 'enqueued checks', { users: active.rows.length });
}

export const massOutreach: JobDescriptor<'mass-outreach'> = { name: 'mass-outreach', process, concurrency: 10 };
