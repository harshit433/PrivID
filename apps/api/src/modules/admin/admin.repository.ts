/**
 * Admin repository — moderation reads/writes over users, identities, reports, appeals,
 * and the immutable admin-action audit log. Account-state changes update the user and
 * their identity together, in one transaction.
 */
import {
  db,
  users,
  identities,
  userReports,
  adminActions,
  accountAppeals,
  eq,
  and,
  or,
  lt,
  sql,
  desc,
  count,
} from '@trustroute/core';
import type { AccountStatus } from '@trustroute/core';

export type AdminActionRow = typeof adminActions.$inferSelect;

// ── Users ─────────────────────────────────────────────────────────────────────

export async function userView(userId: string) {
  const [row] = await db
    .select({
      userId: users.userId,
      handle: users.handle,
      displayName: users.displayName,
      legalName: users.legalName,
      accountStatus: users.accountStatus,
      accountStatusReason: users.accountStatusReason,
      isActive: users.isActive,
      isUnderReview: users.isUnderReview,
      trustScore: users.trustScore,
      identityId: users.identityId,
      identityStatus: identities.status,
      createdAt: users.createdAt,
    })
    .from(users)
    .leftJoin(identities, eq(identities.identityId, users.identityId))
    .where(eq(users.userId, userId))
    .limit(1);
  if (!row) return null;
  const [countRow] = await db
    .select({ n: count() })
    .from(userReports)
    .where(eq(userReports.reportedUserId, userId));
  return { ...row, reportCount: Number(countRow?.n ?? 0) };
}

export interface AccountStateChange {
  accountStatus: AccountStatus;
  identityStatus?: 'active' | 'self_deleted' | 'suspended' | 'banned' | 'ousted';
  isActive: boolean;
  isUnderReview: boolean;
  reason?: string | null;
}

/** Update the user + (optionally) their identity together. Returns false if no such user. */
export async function applyAccountState(userId: string, change: AccountStateChange): Promise<boolean> {
  return db.transaction(async (tx) => {
    const rows = await tx
      .update(users)
      .set({
        accountStatus: change.accountStatus,
        accountStatusReason: change.reason ?? null,
        accountStatusUpdatedAt: sql`now()`,
        isActive: change.isActive,
        isUnderReview: change.isUnderReview,
        suspendedAt: change.accountStatus === 'suspended' ? sql`now()` : users.suspendedAt,
        bannedAt: change.accountStatus === 'banned' ? sql`now()` : users.bannedAt,
        updatedAt: sql`now()`,
      })
      .where(eq(users.userId, userId))
      .returning({ identityId: users.identityId });
    if (rows.length === 0) return false;
    const identityId = rows[0]!.identityId;
    if (identityId && change.identityStatus) {
      await tx
        .update(identities)
        .set({ status: change.identityStatus, statusReason: change.reason ?? null, updatedAt: sql`now()` })
        .where(eq(identities.identityId, identityId));
    }
    return true;
  });
}

// ── Reports ───────────────────────────────────────────────────────────────────

export interface ReportView {
  reportId: string;
  reporterId: string;
  reportedUserId: string | null;
  reportedNumberE164: string | null;
  reasonType: string;
  note: string | null;
  signalWeight: string;
  createdAt: Date;
}

export async function listReports(limit: number, cursor: { t: string; id: string } | null): Promise<ReportView[]> {
  const where = cursor
    ? or(
        lt(userReports.createdAt, new Date(cursor.t)),
        and(eq(userReports.createdAt, new Date(cursor.t)), lt(userReports.reportId, cursor.id)),
      )
    : undefined;
  return db
    .select({
      reportId: userReports.reportId,
      reporterId: userReports.reporterId,
      reportedUserId: userReports.reportedUserId,
      reportedNumberE164: userReports.reportedNumberE164,
      reasonType: userReports.reasonType,
      note: userReports.note,
      signalWeight: userReports.signalWeight,
      createdAt: userReports.createdAt,
    })
    .from(userReports)
    .where(where)
    .orderBy(desc(userReports.createdAt), desc(userReports.reportId))
    .limit(limit + 1);
}

// ── Audit log ─────────────────────────────────────────────────────────────────

export async function logAction(input: {
  targetId?: string | null;
  action: string;
  adminRef?: string | null;
  note?: string | null;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  await db.insert(adminActions).values({
    targetId: input.targetId ?? null,
    action: input.action,
    adminRef: input.adminRef ?? null,
    note: input.note ?? null,
    metadata: (input.metadata ?? {}) as AdminActionRow['metadata'],
  });
}

export async function listActions(limit: number, cursor: { t: string; id: string } | null): Promise<AdminActionRow[]> {
  const where = cursor
    ? or(
        lt(adminActions.createdAt, new Date(cursor.t)),
        and(eq(adminActions.createdAt, new Date(cursor.t)), lt(adminActions.actionId, cursor.id)),
      )
    : undefined;
  return db
    .select()
    .from(adminActions)
    .where(where)
    .orderBy(desc(adminActions.createdAt), desc(adminActions.actionId))
    .limit(limit + 1);
}

// ── Appeals ───────────────────────────────────────────────────────────────────

export async function listAppeals(status?: string) {
  const q = db.select().from(accountAppeals);
  const rows = status
    ? await q.where(eq(accountAppeals.status, status as typeof accountAppeals.$inferSelect['status'])).orderBy(desc(accountAppeals.createdAt)).limit(100)
    : await q.orderBy(desc(accountAppeals.createdAt)).limit(100);
  return rows;
}

export async function resolveAppeal(
  appealId: string,
  input: { status: 'in_review' | 'restored' | 'upheld' | 'rejected'; resolution?: string; reviewerMessage?: string; resolvedBy: string },
): Promise<boolean> {
  const rows = await db
    .update(accountAppeals)
    .set({
      status: input.status,
      resolution: input.resolution ?? null,
      reviewerMessage: input.reviewerMessage ?? null,
      resolvedBy: input.resolvedBy,
      resolvedAt: sql`now()`,
      updatedAt: sql`now()`,
    })
    .where(eq(accountAppeals.appealId, appealId))
    .returning({ id: accountAppeals.appealId });
  return rows.length > 0;
}
