/**
 * Masked-calling repository (PSTN via Exotel). The callee's real number is stored only
 * as a hash; a pooled virtual number bridges the two parties. Billing fields are BIGINT
 * paise. Virtual numbers are leased least-recently-used from an active pool.
 */
import {
  db,
  numberPool,
  maskedCalls,
  maskedCallReports,
  eq,
  and,
  or,
  lt,
  sql,
  desc,
} from '@trustroute/core';

export type MaskedCallRow = typeof maskedCalls.$inferSelect;

/**
 * Lease an active virtual number (least-recently-used) and stamp it with the call ref.
 * Returns null when the pool is exhausted. `FOR UPDATE SKIP LOCKED` avoids two calls
 * grabbing the same number under concurrency.
 */
export async function leaseVirtualNumber(assignedRef: string): Promise<string | null> {
  return db.transaction(async (tx) => {
    const picked = await tx.execute(sql`
      SELECT virtual_number FROM number_pool
      WHERE status = 'active'
      ORDER BY updated_at ASC NULLS FIRST
      LIMIT 1 FOR UPDATE SKIP LOCKED
    `);
    const row = picked.rows[0] as { virtual_number: string } | undefined;
    if (!row) return null;
    await tx
      .update(numberPool)
      .set({ assignedRef, updatedAt: sql`now()` })
      .where(eq(numberPool.virtualNumber, row.virtual_number));
    return row.virtual_number;
  });
}

export async function createMaskedCall(input: {
  callerId: string;
  calleeNumberHash: string;
  calleeDisplay?: string | null;
  virtualNumber: string;
  providerRef: string;
  landingToken: string;
  holdPaise: number;
}): Promise<MaskedCallRow> {
  const [row] = await db
    .insert(maskedCalls)
    .values({
      callerId: input.callerId,
      calleeNumberHash: input.calleeNumberHash,
      calleeDisplay: input.calleeDisplay ?? null,
      virtualNumber: input.virtualNumber,
      providerRef: input.providerRef,
      landingToken: input.landingToken,
      holdPaise: input.holdPaise,
      status: 'ringing_callee',
      startedAt: sql`now()`,
    })
    .returning();
  return row!;
}

export async function findForCaller(callId: string, callerId: string): Promise<MaskedCallRow | null> {
  const [row] = await db
    .select()
    .from(maskedCalls)
    .where(and(eq(maskedCalls.callId, callId), eq(maskedCalls.callerId, callerId)))
    .limit(1);
  return row ?? null;
}

export async function markConnected(callId: string): Promise<MaskedCallRow | null> {
  const [row] = await db
    .update(maskedCalls)
    .set({ status: 'connected', connectedAt: sql`now()` })
    .where(and(eq(maskedCalls.callId, callId), sql`${maskedCalls.status} IN ('placing','ringing_caller','ringing_callee')`))
    .returning();
  return row ?? null;
}

/** End + bill. `costPaise` supplied by the service from measured duration. */
export async function markEnded(callId: string, billedSeconds: number, costPaise: number): Promise<MaskedCallRow | null> {
  const [row] = await db
    .update(maskedCalls)
    .set({ status: 'ended', endedAt: sql`now()`, billedSeconds, costPaise })
    .where(and(eq(maskedCalls.callId, callId), sql`${maskedCalls.status} <> 'ended'`))
    .returning();
  return row ?? null;
}

export async function listForCaller(
  callerId: string,
  limit: number,
  cursor: { t: string; id: string } | null,
): Promise<MaskedCallRow[]> {
  const where = cursor
    ? and(
        eq(maskedCalls.callerId, callerId),
        or(
          lt(maskedCalls.createdAt, new Date(cursor.t)),
          and(eq(maskedCalls.createdAt, new Date(cursor.t)), lt(maskedCalls.callId, cursor.id)),
        ),
      )
    : eq(maskedCalls.callerId, callerId);
  return db
    .select()
    .from(maskedCalls)
    .where(where)
    .orderBy(desc(maskedCalls.createdAt), desc(maskedCalls.callId))
    .limit(limit + 1);
}

export async function createReport(input: {
  virtualNumber?: string | null;
  callRef?: string | null;
  reason: string;
  reporterHash?: string | null;
}): Promise<void> {
  await db.insert(maskedCallReports).values({
    virtualNumber: input.virtualNumber ?? null,
    callRef: input.callRef ?? null,
    reason: input.reason,
    reporterHash: input.reporterHash ?? null,
  });
}

/** Seed helper for dev/tests: ensure at least one virtual number exists in the pool. */
export async function ensureDevPool(numbers: string[]): Promise<void> {
  for (const n of numbers) {
    await db.insert(numberPool).values({ virtualNumber: n }).onConflictDoNothing();
  }
}
