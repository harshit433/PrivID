/**
 * Time-series simulation — teardown.
 * Removes all tsim_ accounts and their dependent rows from the production DB.
 */

import { query } from '@trustroute/shared';

export async function teardownSim(): Promise<{ removed_users: number }> {
  const before = await query<{ c: string }>(`SELECT COUNT(*)::text c FROM users WHERE handle LIKE 'tsim_%'`, []);
  await query(
    `WITH sim AS (SELECT user_id FROM users WHERE handle LIKE 'tsim_%'),
          ch  AS (SELECT channel_id FROM reachability_channels WHERE owner_id IN (SELECT user_id FROM sim))
     , d0 AS (DELETE FROM channel_usage_log   WHERE channel_id IN (SELECT channel_id FROM ch) OR caller_id IN (SELECT user_id FROM sim))
     , d1 AS (DELETE FROM behavior_events     WHERE user_id IN (SELECT user_id FROM sim) OR target_user_id IN (SELECT user_id FROM sim))
     , d2 AS (DELETE FROM trust_score_history WHERE user_id IN (SELECT user_id FROM sim))
     , d3 AS (DELETE FROM trust_factors       WHERE user_id IN (SELECT user_id FROM sim))
     , d4 AS (DELETE FROM connections         WHERE owner_id IN (SELECT user_id FROM sim) OR contact_id IN (SELECT user_id FROM sim))
     , d5 AS (DELETE FROM calls               WHERE caller_id IN (SELECT user_id FROM sim) OR callee_id IN (SELECT user_id FROM sim))
     , d6 AS (DELETE FROM reachability_channels WHERE owner_id IN (SELECT user_id FROM sim))
     SELECT 1`,
    [],
  );
  await query(`DELETE FROM users WHERE handle LIKE 'tsim_%'`, []);
  return { removed_users: parseInt(before[0]?.c ?? '0', 10) };
}
