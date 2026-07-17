/**
 * Handle-propagation. When a user changes their handle, the API records a row in
 * handle_propagation_jobs; the scheduler's scan enqueues one job per pending row. v2
 * connections reference contacts by id (no denormalized handle), so the only external
 * copy to reconcile is the Stream identity — we re-upsert it and mark the job done,
 * recording how many contacts point at this user for observability.
 */
import { db, handlePropagationJobs, connections, users, eq, sql, count, getStreamProvider, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

async function runOne(jobId: string): Promise<void> {
  const [claimed] = await db
    .update(handlePropagationJobs)
    .set({ status: 'processing' })
    .where(sql`${handlePropagationJobs.jobId} = ${jobId} AND ${handlePropagationJobs.status} = 'pending'`)
    .returning();
  if (!claimed) return; // already handled by another worker

  try {
    const [profile] = await db
      .select({ displayName: users.displayName, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.userId, claimed.userId))
      .limit(1);
    await getStreamProvider().upsertUser({ id: claimed.userId, name: profile?.displayName ?? claimed.newHandle, image: profile?.avatarUrl ?? undefined });

    const [c] = await db.select({ n: count() }).from(connections).where(eq(connections.contactId, claimed.userId));
    await db
      .update(handlePropagationJobs)
      .set({ status: 'done', connectionsUpdated: Number(c?.n ?? 0), completedAt: sql`now()` })
      .where(eq(handlePropagationJobs.jobId, jobId));
    logger.info('worker:handle-propagation', 'propagated', { jobId, userId: claimed.userId, contacts: Number(c?.n ?? 0) });
  } catch (err) {
    await db.update(handlePropagationJobs).set({ status: 'failed' }).where(eq(handlePropagationJobs.jobId, jobId));
    throw err;
  }
}

const process: Processor<JobMap['handle-propagation']> = async (job) => {
  if (job.data.job_id) {
    await runOne(job.data.job_id);
    return;
  }
  // Scan mode: process every pending row.
  const pending = await db
    .select({ jobId: handlePropagationJobs.jobId })
    .from(handlePropagationJobs)
    .where(sql`${handlePropagationJobs.status} = 'pending'`)
    .limit(200);
  for (const { jobId } of pending) {
    try {
      await runOne(jobId);
    } catch (err) {
      logger.warn('worker:handle-propagation', 'row failed', { jobId, error: (err as Error).message });
    }
  }
};

export const handlePropagation: JobDescriptor<'handle-propagation'> = { name: 'handle-propagation', process, concurrency: 2 };
