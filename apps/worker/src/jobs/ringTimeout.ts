/**
 * Ring-timeout: enqueued (delayed) by the API when a call starts ringing. When it
 * fires, any call still in `initiated`/`ringing` is marked `missed` — the backstop for
 * a callee who never answered and a client that never sent decline/end.
 */
import { db, calls, eq, and, sql, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const process: Processor<JobMap['ring-timeout']> = async (job) => {
  const { call_id } = job.data;
  const rows = await db
    .update(calls)
    .set({ status: 'missed', endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(calls.callId, call_id), sql`${calls.status} IN ('initiated','ringing')`))
    .returning({ id: calls.callId });
  if (rows.length) logger.info('worker:ring-timeout', 'call marked missed', { callId: call_id });
};

export const ringTimeout: JobDescriptor<'ring-timeout'> = { name: 'ring-timeout', process };
