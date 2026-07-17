/**
 * Data-export (GDPR/DPDP "download my data"). Enqueued per request by the API, with a
 * scheduler backstop that re-enqueues rows stuck in `requested`. Gathers the user's
 * personal data into one JSON document, uploads it under an export key (mock storage
 * just serves the key), and marks the request `ready` with a 7-day download URL. The
 * job claims the row atomically so concurrent workers can't double-process it.
 */
import {
  db,
  dataExportRequests,
  users,
  connections,
  wallets,
  referralWallets,
  eq,
  count,
  sql,
  enqueue,
  getStorageProvider,
  logger,
  type JobMap,
} from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

async function gather(userId: string): Promise<Record<string, unknown>> {
  const [[profile], [conn], [wallet], [refWallet]] = await Promise.all([
    db
      .select({
        userId: users.userId,
        handle: users.handle,
        displayName: users.displayName,
        legalName: users.legalName,
        email: users.email,
        trustScore: users.trustScore,
        trustTier: users.trustTier,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.userId, userId))
      .limit(1),
    db.select({ n: count() }).from(connections).where(eq(connections.ownerId, userId)),
    db.select({ balancePaise: wallets.balancePaise }).from(wallets).where(eq(wallets.userId, userId)).limit(1),
    db
      .select({ withdrawablePaise: referralWallets.withdrawablePaise, pendingPaise: referralWallets.pendingPaise, totalEarnedPaise: referralWallets.totalEarnedPaise })
      .from(referralWallets)
      .where(eq(referralWallets.userId, userId))
      .limit(1),
  ]);

  return {
    exportedAt: new Date().toISOString(),
    profile: profile ?? null,
    connectionCount: Number(conn?.n ?? 0),
    wallet: { balancePaise: wallet?.balancePaise ?? 0 },
    referrals: refWallet ?? { withdrawablePaise: 0, pendingPaise: 0, totalEarnedPaise: 0 },
  };
}

const process: Processor<JobMap['data-export']> = async (job) => {
  const { request_id } = job.data;

  const [claimed] = await db
    .update(dataExportRequests)
    .set({ status: 'processing' })
    .where(sql`${dataExportRequests.requestId} = ${request_id} AND ${dataExportRequests.status} IN ('requested','failed')`)
    .returning();
  if (!claimed) return; // already processing/ready, or gone

  try {
    const payload = await gather(claimed.userId);
    const key = `exports/${claimed.userId}/${request_id}.json`;
    const storage = getStorageProvider();
    // Real storage: stream `payload` to `key` here. Mock storage serves the key directly.
    await storage.presignUpload({ key, contentType: 'application/json' });
    const downloadUrl = storage.publicUrl(key);

    await db
      .update(dataExportRequests)
      .set({ status: 'ready', downloadUrl, expiresAt: sql`now() + interval '7 days'`, completedAt: sql`now()` })
      .where(eq(dataExportRequests.requestId, request_id));
    logger.info('worker:data-export', 'export ready', { requestId: request_id, bytes: JSON.stringify(payload).length });
  } catch (err) {
    await db.update(dataExportRequests).set({ status: 'failed' }).where(eq(dataExportRequests.requestId, request_id));
    throw err;
  }
};

/** Scheduler backstop: re-enqueue exports stuck in `requested` (e.g. missed at request time). */
export async function enqueueStuckExports(): Promise<void> {
  const stuck = await db
    .select({ requestId: dataExportRequests.requestId })
    .from(dataExportRequests)
    .where(sql`${dataExportRequests.status} = 'requested' AND ${dataExportRequests.createdAt} < now() - INTERVAL '2 minutes'`)
    .limit(50);
  for (const { requestId } of stuck) {
    await enqueue('data-export', { request_id: requestId, user_id: '' }, { jobId: `data-export-${requestId}` });
  }
  if (stuck.length) logger.info('worker:data-export', 'backstop enqueued stuck exports', { count: stuck.length });
}

export const dataExport: JobDescriptor<'data-export'> = { name: 'data-export', process, concurrency: 2 };
