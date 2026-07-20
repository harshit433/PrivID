/**
 * Approval-request repository. Requests belong to a user; a lazy sweep expires
 * overdue pending rows so a stale request never appears approvable.
 */
import {
  db,
  approvalRequests,
  eq,
  and,
  lt,
  desc,
  sql,
} from '@trustroute/core';

export type ApprovalRow = typeof approvalRequests.$inferSelect;

export async function create(input: {
  userId: string;
  relyingParty: string;
  action: string;
  expiresAt: Date;
  context: Record<string, string>;
}): Promise<ApprovalRow> {
  const [row] = await db
    .insert(approvalRequests)
    .values({
      userId: input.userId,
      relyingParty: input.relyingParty,
      action: input.action,
      expiresAt: input.expiresAt,
      context: input.context,
    })
    .returning();
  return row!;
}

/** Flip any of this user's pending-but-overdue requests to 'expired'. */
export async function expireOverdue(userId: string): Promise<void> {
  await db
    .update(approvalRequests)
    .set({ status: 'expired', updatedAt: sql`now()` })
    .where(
      and(
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
        lt(approvalRequests.expiresAt, sql`now()`),
      ),
    );
}

export async function listForUser(
  userId: string,
  status?: 'pending' | 'approved' | 'denied' | 'expired',
): Promise<ApprovalRow[]> {
  return db
    .select()
    .from(approvalRequests)
    .where(
      status
        ? and(eq(approvalRequests.userId, userId), eq(approvalRequests.status, status))
        : eq(approvalRequests.userId, userId),
    )
    .orderBy(desc(approvalRequests.createdAt))
    .limit(100);
}

export async function getOwned(userId: string, requestId: string): Promise<ApprovalRow | null> {
  const [row] = await db
    .select()
    .from(approvalRequests)
    .where(and(eq(approvalRequests.requestId, requestId), eq(approvalRequests.userId, userId)));
  return row ?? null;
}

/** Respond only if still pending (guards against double-respond / races). */
export async function respondIfPending(
  userId: string,
  requestId: string,
  status: 'approved' | 'denied',
): Promise<ApprovalRow | null> {
  const [row] = await db
    .update(approvalRequests)
    .set({ status, respondedAt: sql`now()`, updatedAt: sql`now()` })
    .where(
      and(
        eq(approvalRequests.requestId, requestId),
        eq(approvalRequests.userId, userId),
        eq(approvalRequests.status, 'pending'),
      ),
    )
    .returning();
  return row ?? null;
}
