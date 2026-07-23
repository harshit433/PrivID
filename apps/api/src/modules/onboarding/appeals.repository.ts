/**
 * Account appeals. A user who is suspended, banned or ousted has no session, so
 * appeals are addressed by identity/user id (resolved from their onboarding
 * session where possible) rather than by an authenticated subject.
 */
import { db, accountAppeals, eq, and, or, desc, sql } from '@trustroute/core';

export type AppealRow = typeof accountAppeals.$inferSelect;

/** Statuses that mean "already being handled" — a second appeal adds nothing. */
const OPEN_STATUSES = ['submitted', 'in_review'] as const;

export async function create(input: {
  userId: string | null;
  identityId: string | null;
  reason: string;
  evidence: string | null;
}): Promise<AppealRow> {
  const [row] = await db
    .insert(accountAppeals)
    .values({
      userId: input.userId,
      identityId: input.identityId,
      reason: input.reason,
      evidence: input.evidence,
    })
    .returning();
  return row!;
}

function subjectFilter(subject: { userId?: string | null; identityId?: string | null }) {
  const clauses = [];
  if (subject.identityId) clauses.push(eq(accountAppeals.identityId, subject.identityId));
  if (subject.userId) clauses.push(eq(accountAppeals.userId, subject.userId));
  return clauses.length === 1 ? clauses[0]! : or(...clauses);
}

/** Most recent appeal for this identity/user, whatever its state. */
export async function latestFor(subject: {
  userId?: string | null;
  identityId?: string | null;
}): Promise<AppealRow | null> {
  if (!subject.userId && !subject.identityId) return null;
  const [row] = await db
    .select()
    .from(accountAppeals)
    .where(subjectFilter(subject))
    .orderBy(desc(accountAppeals.createdAt))
    .limit(1);
  return row ?? null;
}

/** An appeal already queued for review, so we don't stack duplicates. */
export async function findOpen(subject: {
  userId?: string | null;
  identityId?: string | null;
}): Promise<AppealRow | null> {
  if (!subject.userId && !subject.identityId) return null;
  const [row] = await db
    .select()
    .from(accountAppeals)
    .where(and(subjectFilter(subject), sql`${accountAppeals.status} IN ('submitted','in_review')`))
    .orderBy(desc(accountAppeals.createdAt))
    .limit(1);
  return row ?? null;
}

export { OPEN_STATUSES };
