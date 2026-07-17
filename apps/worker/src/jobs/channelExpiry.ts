/**
 * Channel-expiry scan. Marks active reachability channels `expired` once their expiry
 * time has passed or their total-use limit is reached. Single batch UPDATE — idempotent.
 */
import { db, reachabilityChannels, sql, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const process: Processor<JobMap['channel-expiry']> = async () => {
  const expired = await db
    .update(reachabilityChannels)
    .set({ status: 'expired' })
    .where(
      sql`${reachabilityChannels.status} = 'active' AND (
        (${reachabilityChannels.expiresAt} IS NOT NULL AND ${reachabilityChannels.expiresAt} < now())
        OR (${reachabilityChannels.totalLimit} IS NOT NULL AND ${reachabilityChannels.useCount} >= ${reachabilityChannels.totalLimit})
      )`,
    )
    .returning({ channelId: reachabilityChannels.channelId });
  if (expired.length) logger.info('worker:channel-expiry', 'expired channels', { count: expired.length });
};

export const channelExpiry: JobDescriptor<'channel-expiry'> = { name: 'channel-expiry', process, concurrency: 2 };
