/**
 * Status-expiry scan. Deletes ephemeral status updates past their 24h TTL. Media objects
 * are left to storage lifecycle rules (mock storage has none); we only purge the rows.
 */
import { db, userStatusUpdates, sql, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const process: Processor<JobMap['status-expiry']> = async () => {
  const purged = await db
    .delete(userStatusUpdates)
    .where(sql`${userStatusUpdates.expiresAt} < now()`)
    .returning({ statusId: userStatusUpdates.statusId });
  if (purged.length) logger.info('worker:status-expiry', 'purged expired status', { count: purged.length });
};

export const statusExpiry: JobDescriptor<'status-expiry'> = { name: 'status-expiry', process, concurrency: 1 };
