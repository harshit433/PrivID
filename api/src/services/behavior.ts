/**
 * Behavior tracking service
 *
 * Records user events used by:
 *   1. Mass outreach detection (worker job)
 *   2. Trust score behavior_modifier computation
 *   3. Audit trail
 */

import { query } from '@trustroute/shared';

export type BehaviorEventType =
  | 'call_initiated'
  | 'call_answered'
  | 'call_declined'
  | 'call_missed'
  | 'contact_blocked'
  | 'contact_added'
  | 'channel_created'
  | 'channel_used'
  | 'mass_outreach_flag'      // set by worker job
  | 'login'
  | 'profile_updated';

export async function trackEvent(
  userId: string,
  eventType: BehaviorEventType,
  targetUserId?: string,
  metadata: Record<string, unknown> = {}
): Promise<void> {
  await query(
    `INSERT INTO behavior_events (user_id, event_type, target_user_id, metadata)
     VALUES ($1, $2, $3, $4)`,
    [userId, eventType, targetUserId ?? null, JSON.stringify(metadata)]
  );
}

/**
 * Returns outreach stats for a user in the last N minutes.
 * Used by the mass outreach detection job.
 */
export async function getOutreachStats(userId: string, windowMinutes = 60) {
  const [stats] = await query<{
    unique_callees: string;
    total_calls: string;
    declined_by_callee: string;
  }>(
    `SELECT
       COUNT(DISTINCT c.callee_id)::text AS unique_callees,
       COUNT(*)::text AS total_calls,
       COUNT(*) FILTER (WHERE c.status = 'declined')::text AS declined_by_callee
     FROM calls c
     WHERE c.caller_id = $1
       AND c.created_at > NOW() - ($2 || ' minutes')::INTERVAL`,
    [userId, windowMinutes]
  );
  return {
    uniqueCallees: parseInt(stats.unique_callees),
    totalCalls: parseInt(stats.total_calls),
    declinedByCalle: parseInt(stats.declined_by_callee),
  };
}

/**
 * Thresholds for mass outreach detection (per hour):
 *   - calls to >15 unique users        → flag
 *   - >20 total calls                  → flag
 *   - decline rate >70% (min 5 calls)  → flag
 */
export async function checkMassOutreach(userId: string): Promise<boolean> {
  const stats = await getOutreachStats(userId, 60);

  const declineRate = stats.totalCalls >= 5
    ? stats.declinedByCalle / stats.totalCalls
    : 0;

  return (
    stats.uniqueCallees > 15 ||
    stats.totalCalls > 20 ||
    declineRate > 0.7
  );
}
