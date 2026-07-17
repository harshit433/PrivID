/**
 * Activities repository — shared watch-together / screen-share sessions scoped to a
 * direct pair or a group. Durable metadata + last-known sync state live here; a partial
 * unique index guarantees at most one active session per pair/group.
 */
import { db, activitySessions, activityParticipants, users, eq, and, sql, desc } from '@trustroute/core';

export type ActivityRow = typeof activitySessions.$inferSelect;
export type ParticipantRow = typeof activityParticipants.$inferSelect;

export async function findActiveDirect(low: string, high: string): Promise<ActivityRow | null> {
  const [row] = await db
    .select()
    .from(activitySessions)
    .where(
      and(
        eq(activitySessions.scopeType, 'direct'),
        eq(activitySessions.directMemberLow, low),
        eq(activitySessions.directMemberHigh, high),
        eq(activitySessions.status, 'active'),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function findActiveGroup(groupId: string): Promise<ActivityRow | null> {
  const [row] = await db
    .select()
    .from(activitySessions)
    .where(and(eq(activitySessions.scopeType, 'group'), eq(activitySessions.groupId, groupId), eq(activitySessions.status, 'active')))
    .limit(1);
  return row ?? null;
}

export async function create(input: {
  scopeType: 'direct' | 'group';
  directMemberLow?: string | null;
  directMemberHigh?: string | null;
  groupId?: string | null;
  adapter: 'youtube' | 'screen_share';
  streamCallId: string;
  hostUserId: string;
}): Promise<ActivityRow> {
  const [row] = await db
    .insert(activitySessions)
    .values({
      scopeType: input.scopeType,
      directMemberLow: input.directMemberLow ?? null,
      directMemberHigh: input.directMemberHigh ?? null,
      groupId: input.groupId ?? null,
      adapter: input.adapter,
      streamCallId: input.streamCallId,
      hostUserId: input.hostUserId,
      controllerUserId: input.hostUserId,
      createdBy: input.hostUserId,
    })
    .returning();
  return row!;
}

export async function findById(activityId: string): Promise<ActivityRow | null> {
  const [row] = await db.select().from(activitySessions).where(eq(activitySessions.activityId, activityId)).limit(1);
  return row ?? null;
}

export async function addParticipant(activityId: string, userId: string, role: 'host' | 'participant'): Promise<void> {
  await db
    .insert(activityParticipants)
    .values({ activityId, userId, role })
    .onConflictDoUpdate({
      target: [activityParticipants.activityId, activityParticipants.userId],
      set: { leftAt: null, role: sql`EXCLUDED.role` },
    });
}

export async function markLeft(activityId: string, userId: string): Promise<void> {
  await db
    .update(activityParticipants)
    .set({ leftAt: sql`now()` })
    .where(and(eq(activityParticipants.activityId, activityId), eq(activityParticipants.userId, userId)));
}

export async function listParticipants(activityId: string) {
  return db
    .select({
      userId: users.userId,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      role: activityParticipants.role,
      joinedAt: activityParticipants.joinedAt,
      leftAt: activityParticipants.leftAt,
    })
    .from(activityParticipants)
    .innerJoin(users, eq(users.userId, activityParticipants.userId))
    .where(eq(activityParticipants.activityId, activityId))
    .orderBy(desc(activityParticipants.role), activityParticipants.joinedAt);
}

/** Optimistic state update: only applies if the caller's base revision is current. */
export async function updateState(
  activityId: string,
  state: Record<string, unknown>,
  baseRevision: number,
): Promise<ActivityRow | null> {
  const [row] = await db
    .update(activitySessions)
    .set({
      lastState: state as ActivityRow['lastState'],
      stateRevision: sql`${activitySessions.stateRevision} + 1`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(activitySessions.activityId, activityId), eq(activitySessions.stateRevision, baseRevision), eq(activitySessions.status, 'active')))
    .returning();
  return row ?? null;
}

export async function setPresenter(activityId: string, presenterUserId: string | null): Promise<void> {
  await db
    .update(activitySessions)
    .set({ presenterUserId, updatedAt: sql`now()` })
    .where(eq(activitySessions.activityId, activityId));
}

export async function setController(activityId: string, controllerUserId: string): Promise<void> {
  await db
    .update(activitySessions)
    .set({ controllerUserId, updatedAt: sql`now()` })
    .where(eq(activitySessions.activityId, activityId));
}

export async function end(activityId: string): Promise<ActivityRow | null> {
  const [row] = await db
    .update(activitySessions)
    .set({ status: 'ended', endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(activitySessions.activityId, activityId), eq(activitySessions.status, 'active')))
    .returning();
  return row ?? null;
}

/** Is the user in scope for this activity (direct member or, for group, we check outside)? */
export function isDirectMember(a: ActivityRow, userId: string): boolean {
  return a.directMemberLow === userId || a.directMemberHigh === userId;
}
