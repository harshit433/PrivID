/**
 * Token cleanup (daily). Purges refresh tokens that are expired or revoked and older
 * than 7 days — keeps recently-revoked rows around briefly for audit/replay-detection.
 * (v2 dropped OTP sessions, so there is nothing else to clean here.)
 */
import { db, refreshTokens, sql, logger, type JobMap } from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const process: Processor<JobMap['token-rotation']> = async () => {
  const purged = await db
    .delete(refreshTokens)
    .where(sql`(${refreshTokens.expiresAt} < now() OR ${refreshTokens.revoked} = TRUE) AND ${refreshTokens.createdAt} < now() - INTERVAL '7 days'`)
    .returning({ tokenId: refreshTokens.tokenId });
  logger.info('worker:token-rotation', 'purged stale refresh tokens', { count: purged.length });
};

export const tokenRotation: JobDescriptor<'token-rotation'> = { name: 'token-rotation', process, concurrency: 1 };
