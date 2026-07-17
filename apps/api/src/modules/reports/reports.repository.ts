/**
 * Reports repository — trust-weighted user/number reports feeding moderation + trust.
 * A report can target a user (SET NULL on their deletion so the record survives) or a
 * raw phone number.
 */
import { db, userReports, eq, and, gt, sql, desc } from '@trustroute/core';

export type ReportRow = typeof userReports.$inferSelect;

export async function create(input: {
  reporterId: string;
  reportedUserId?: string | null;
  reportedNumberE164?: string | null;
  reasonType: ReportRow['reasonType'];
  note?: string | null;
  contextType?: ReportRow['contextType'] | null;
  contextId?: string | null;
  signalWeight: string;
  blockAlso: boolean;
}): Promise<ReportRow> {
  const [row] = await db
    .insert(userReports)
    .values({
      reporterId: input.reporterId,
      reportedUserId: input.reportedUserId ?? null,
      reportedNumberE164: input.reportedNumberE164 ?? null,
      reasonType: input.reasonType,
      note: input.note ?? null,
      contextType: input.contextType ?? null,
      contextId: input.contextId ?? null,
      signalWeight: input.signalWeight,
      blockAlso: input.blockAlso,
    })
    .returning();
  return row!;
}

/** Did this reporter already report this user recently? (dedupe within a window) */
export async function recentDuplicate(reporterId: string, reportedUserId: string, sinceHours = 24): Promise<boolean> {
  const [row] = await db
    .select({ id: userReports.reportId })
    .from(userReports)
    .where(
      and(
        eq(userReports.reporterId, reporterId),
        eq(userReports.reportedUserId, reportedUserId),
        gt(userReports.createdAt, sql`now() - (${sinceHours} || ' hours')::interval`),
      ),
    )
    .limit(1);
  return Boolean(row);
}

export async function listByReporter(reporterId: string): Promise<ReportRow[]> {
  return db
    .select()
    .from(userReports)
    .where(eq(userReports.reporterId, reporterId))
    .orderBy(desc(userReports.createdAt))
    .limit(50);
}
