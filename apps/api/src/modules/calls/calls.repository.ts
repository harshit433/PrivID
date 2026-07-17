/**
 * Calls repository — in-app (Stream Video) call rows, quality reports, and the
 * append-only behavior-event log that feeds trust/abuse signals. History joins the
 * "counterpart" (the other party) so the client renders a call log without N+1 reads.
 */
import {
  db,
  calls,
  callQualityReports,
  behaviorEvents,
  users,
  eq,
  and,
  or,
  lt,
  sql,
  desc,
} from '@trustroute/core';

export type CallRow = typeof calls.$inferSelect;

export interface CallWithCounterpart {
  callId: string;
  callType: CallRow['callType'];
  status: CallRow['status'];
  direction: 'outgoing' | 'incoming';
  streamCallId: string | null;
  startedAt: Date | null;
  endedAt: Date | null;
  durationSeconds: number | null;
  declineReason: string | null;
  createdAt: Date;
  counterpart: {
    userId: string;
    handle: string;
    displayName: string | null;
    avatarUrl: string | null;
    trustTier: (typeof users.$inferSelect)['trustTier'];
  };
}

function counterpartSelection(viewerId: string) {
  return {
    callId: calls.callId,
    callType: calls.callType,
    status: calls.status,
    direction: sql<'outgoing' | 'incoming'>`CASE WHEN ${calls.callerId} = ${viewerId} THEN 'outgoing' ELSE 'incoming' END`,
    streamCallId: calls.streamCallId,
    startedAt: calls.startedAt,
    endedAt: calls.endedAt,
    durationSeconds: calls.durationSeconds,
    declineReason: calls.declineReason,
    createdAt: calls.createdAt,
    counterpart: {
      userId: users.userId,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      trustTier: users.trustTier,
    },
  } as const;
}

const counterpartJoin = (viewerId: string) =>
  sql`${users.userId} = CASE WHEN ${calls.callerId} = ${viewerId} THEN ${calls.calleeId} ELSE ${calls.callerId} END`;

export async function createCall(input: {
  callerId: string;
  calleeId: string;
  callType?: CallRow['callType'];
  channelId?: string | null;
  streamCallId: string;
}): Promise<CallRow> {
  const [row] = await db
    .insert(calls)
    .values({
      callerId: input.callerId,
      calleeId: input.calleeId,
      callType: input.callType ?? 'direct',
      channelId: input.channelId ?? null,
      streamCallId: input.streamCallId,
      status: 'ringing',
    })
    .returning();
  return row!;
}

export async function findById(callId: string): Promise<CallRow | null> {
  const [row] = await db.select().from(calls).where(eq(calls.callId, callId)).limit(1);
  return row ?? null;
}

/** Load a call only if the viewer is a participant (caller or callee). */
export async function findForParticipant(callId: string, userId: string): Promise<CallRow | null> {
  const [row] = await db
    .select()
    .from(calls)
    .where(and(eq(calls.callId, callId), or(eq(calls.callerId, userId), eq(calls.calleeId, userId))))
    .limit(1);
  return row ?? null;
}

/** Transition to answered: only valid from a ringing/initiated call, by the callee. */
export async function markAnswered(callId: string): Promise<CallRow | null> {
  const [row] = await db
    .update(calls)
    .set({ status: 'answered', startedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(calls.callId, callId), sql`${calls.status} IN ('initiated','ringing')`))
    .returning();
  return row ?? null;
}

export async function markDeclined(callId: string, reason: string | null): Promise<CallRow | null> {
  const [row] = await db
    .update(calls)
    .set({ status: 'declined', declineReason: reason, endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(calls.callId, callId), sql`${calls.status} IN ('initiated','ringing')`))
    .returning();
  return row ?? null;
}

/**
 * End a call. Duration is measured from `started_at` (0 if it never connected). Only
 * transitions from a live/ringing state so a double "end" is a no-op.
 */
export async function markEnded(callId: string): Promise<CallRow | null> {
  const [row] = await db
    .update(calls)
    .set({
      status: 'ended',
      endedAt: sql`now()`,
      durationSeconds: sql`GREATEST(0, COALESCE(EXTRACT(EPOCH FROM (now() - ${calls.startedAt}))::int, 0))`,
      updatedAt: sql`now()`,
    })
    .where(and(eq(calls.callId, callId), sql`${calls.status} IN ('initiated','ringing','answered')`))
    .returning();
  return row ?? null;
}

/** Ring-timeout backstop (also used by the worker): unanswered → missed. */
export async function markMissedIfUnanswered(callId: string): Promise<boolean> {
  const rows = await db
    .update(calls)
    .set({ status: 'missed', endedAt: sql`now()`, updatedAt: sql`now()` })
    .where(and(eq(calls.callId, callId), sql`${calls.status} IN ('initiated','ringing')`))
    .returning({ id: calls.callId });
  return rows.length > 0;
}

export async function listForUser(
  viewerId: string,
  limit: number,
  cursor: { t: string; id: string } | null,
): Promise<CallWithCounterpart[]> {
  const participant = or(eq(calls.callerId, viewerId), eq(calls.calleeId, viewerId));
  const where = cursor
    ? and(
        participant,
        or(
          lt(calls.createdAt, new Date(cursor.t)),
          and(eq(calls.createdAt, new Date(cursor.t)), lt(calls.callId, cursor.id)),
        ),
      )
    : participant;
  return db
    .select(counterpartSelection(viewerId))
    .from(calls)
    .innerJoin(users, counterpartJoin(viewerId))
    .where(where)
    .orderBy(desc(calls.createdAt), desc(calls.callId))
    .limit(limit + 1);
}

export async function upsertQuality(
  callId: string,
  userId: string,
  metrics: { mosScore?: number; packetLossPct?: number; jitterMs?: number; rttMs?: number },
): Promise<void> {
  await db
    .insert(callQualityReports)
    .values({
      callId,
      userId,
      mosScore: metrics.mosScore?.toString(),
      packetLossPct: metrics.packetLossPct?.toString(),
      jitterMs: metrics.jitterMs,
      rttMs: metrics.rttMs,
    })
    .onConflictDoUpdate({
      target: [callQualityReports.callId, callQualityReports.userId],
      set: {
        mosScore: metrics.mosScore?.toString(),
        packetLossPct: metrics.packetLossPct?.toString(),
        jitterMs: metrics.jitterMs,
        rttMs: metrics.rttMs,
      },
    });
}

export async function logBehavior(
  userId: string,
  eventType: string,
  targetUserId: string | null,
  metadata: Record<string, unknown> = {},
): Promise<void> {
  await db.insert(behaviorEvents).values({ userId, eventType, targetUserId, metadata });
}
