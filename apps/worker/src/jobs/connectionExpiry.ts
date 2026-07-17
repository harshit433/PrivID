/**
 * Connection-expiry scan. Downgrades temporary connections whose window has elapsed
 * back to `unknown` (the "access expires automatically" promise), records a behavior
 * event for both parties, and enqueues a low-priority trust recompute for the contact
 * who lost the relationship. Idempotent: re-running skips already-downgraded rows.
 */
import { db, connections, behaviorEvents, sql, enqueue, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const process: Processor<JobMap['connection-expiry']> = async () => {
  const expired = await db
    .update(connections)
    .set({ connectionType: 'unknown', temporaryExpiresAt: null, updatedAt: sql`now()` })
    .where(sql`${connections.connectionType} = 'temporary' AND ${connections.temporaryExpiresAt} < now()`)
    .returning({ connectionId: connections.connectionId, ownerId: connections.ownerId, contactId: connections.contactId });

  if (expired.length === 0) return;
  logger.info('worker:connection-expiry', 'downgraded expired temporary connections', { count: expired.length });

  await Promise.allSettled(
    expired.map(async (row) => {
      const meta = { connection_id: row.connectionId, reason: 'temporary_window_elapsed' };
      await db.insert(behaviorEvents).values([
        { userId: row.ownerId, eventType: 'connection_expired', targetUserId: row.contactId, metadata: meta },
        { userId: row.contactId, eventType: 'connection_expired', targetUserId: row.ownerId, metadata: meta },
      ]);
      await enqueue('trust-recompute', { user_id: row.contactId, reason: 'temporary_connection_expired' }, { jobId: `trust-${row.contactId}-connexpiry` });
    }),
  );
};

export const connectionExpiry: JobDescriptor<'connection-expiry'> = { name: 'connection-expiry', process, concurrency: 1 };
