/**
 * PrivID Feature Store — v1
 *
 * Extracts ~45 behavioral features for a user, used by:
 *   - ML trust score models (Python inference service)
 *   - Block intent classifier
 *   - Temporal pattern detector
 *   - Training data export
 *
 * All features are computed from PostgreSQL and are point-in-time snapshots.
 * Hot path (per-call scoring) uses a subset; full extraction is for batch scoring.
 */

import { query, queryOne } from '@privid/shared';

// ─── Feature interface ────────────────────────────────────────────────────────

export interface UserFeatures {
  user_id: string;
  computed_at: string;

  // ── Identity (static / slow-changing) ──────────────────────────────────────
  phone_verified: boolean;
  device_integrity: boolean;
  liveness_check: boolean;
  govt_id_verified: boolean;
  profile_completeness: number;        // 0.0–1.0 (display_name + avatar)
  account_age_days: number;

  // ── Volume (rolling windows) ────────────────────────────────────────────────
  calls_out_1d: number;
  calls_out_7d: number;
  calls_out_30d: number;
  calls_in_1d: number;
  calls_in_7d: number;
  calls_in_30d: number;
  unique_callees_1d: number;
  unique_callees_7d: number;
  unique_callees_30d: number;
  unique_callers_7d: number;
  calls_per_unique_callee_1d: number;  // concentration — high = harassment risk
  new_targets_1d: number;              // callees never contacted in last 30d

  // ── Quality ("was it welcome?") ─────────────────────────────────────────────
  answer_rate_out_1d: number;          // fraction of MY outgoing calls answered
  answer_rate_out_7d: number;
  answer_rate_in_1d: number;           // fraction of INCOMING calls I answer
  answer_rate_in_7d: number;
  avg_call_duration_7d: number;        // seconds; very short = robocall-like
  pct_calls_under_30s_7d: number;      // spam signal if > 0.6
  reciprocal_rate_30d: number;         // % of callees who later called me back
  calls_to_trusted_ratio_7d: number;   // my trusted contacts / total outgoing

  // ── Behavioral patterns ──────────────────────────────────────────────────────
  unknown_call_ratio_7d: number;       // unknown callees / total outgoing
  burst_count_7d: number;              // days in last 7d with >10 outgoing calls
  burst_acceleration: number;          // this-week calls / last-week calls (>2 = spike)
  repeat_call_rate_7d: number;         // re-attempts to same callee / total outgoing
  sequential_dialing_max: number;      // max unique callees in any 30-min window (list-dial signal)
  first_contact_ghost_ratio_30d: number; // targets: answered first call, never again
  consistent_ignorer_count_30d: number;  // targets who NEVER answered any of my calls (≥2 attempts)

  // ── Network ──────────────────────────────────────────────────────────────────
  trusted_contacts_count: number;
  blocked_by_7d: number;
  blocked_by_30d: number;
  block_trusted_ratio: number;         // blocks / (blocks + trusted); high = alarming
  avg_trust_of_network: number;        // avg trust_score of my trusted contacts
  shared_targets_with_flagged: number; // targets I called that were also called by flagged accounts today

  // ── Trend (requires trust_score_history) ────────────────────────────────────
  score_slope_7d: number;              // pts/day; negative = degrading
  behavior_regime: 'stable' | 'escalating' | 'declining' | 'recovering';
}

// ─── Block context ─────────────────────────────────────────────────────────────
// Snapshot of a specific block event, used by BlockIntentClassifier

export interface BlockContext {
  blocker_id: string;               // person doing the blocking
  blocked_id: string;               // person being blocked (the caller)

  calls_before_block: number;       // total interactions before block
  days_known_before_block: number;  // days since first contact
  was_ever_trusted: boolean;        // had a trusted relationship → personal dispute
  block_speed_hours: number;        // hours from first contact to block (low = spam)
  answered_before_block: number;    // calls answered before block
  avg_duration_before_block: number; // seconds; very short avg = spam-like
  mutual_call_count: number;        // times blocker ever called blocked back
  callee_block_propensity: number;  // fraction of blocker's contacts that are blocked
  block_cluster_24h: number;        // distinct people who blocked the same caller today
}

// ─── Main extraction ───────────────────────────────────────────────────────────

export async function extractFeatures(userId: string): Promise<UserFeatures> {
  const [identity, volume, behavioral, network, trend] = await Promise.all([
    getIdentityFeatures(userId),
    getVolumeAndQualityFeatures(userId),
    getBehavioralFeatures(userId),
    getNetworkFeatures(userId),
    getTrendFeatures(userId),
  ]);

  return {
    user_id: userId,
    computed_at: new Date().toISOString(),
    ...identity,
    ...volume,
    ...behavioral,
    ...network,
    ...trend,
  };
}

// ─── Identity ─────────────────────────────────────────────────────────────────

async function getIdentityFeatures(userId: string) {
  const row = await queryOne<{
    account_age_days: number;
    has_display_name: boolean;
    has_avatar: boolean;
    completed_factors: string[];
  }>(
    `SELECT
       EXTRACT(DAY FROM NOW() - created_at)::int AS account_age_days,
       (display_name IS NOT NULL AND display_name != '') AS has_display_name,
       (avatar_url IS NOT NULL) AS has_avatar,
       ARRAY(
         SELECT factor_type FROM trust_factors
         WHERE user_id = $1 AND status = 'completed'
       ) AS completed_factors
     FROM users WHERE user_id = $1`,
    [userId],
  );

  const factors = new Set(row?.completed_factors ?? []);
  const completeness = ((row?.has_display_name ? 0.5 : 0) + (row?.has_avatar ? 0.5 : 0));

  return {
    phone_verified:   factors.has('phone_verified'),
    device_integrity: factors.has('device_integrity'),
    liveness_check:   factors.has('liveness_check'),
    govt_id_verified: factors.has('govt_id_verified'),
    profile_completeness: completeness,
    account_age_days: row?.account_age_days ?? 0,
  };
}

// ─── Volume + Quality (one big aggregation query) ────────────────────────────

async function getVolumeAndQualityFeatures(userId: string) {
  const row = await queryOne<{
    calls_out_1d: string; calls_out_7d: string; calls_out_30d: string;
    calls_in_1d: string;  calls_in_7d: string;  calls_in_30d: string;
    unique_callees_1d: string; unique_callees_7d: string; unique_callees_30d: string;
    unique_callers_7d: string;
    answer_rate_out_1d: string | null; answer_rate_out_7d: string | null;
    answer_rate_in_1d: string | null;  answer_rate_in_7d: string | null;
    avg_duration_7d: string | null;
    pct_under_30s_7d: string | null;
  }>(
    `SELECT
       COUNT(*) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '1 day')::text   AS calls_out_1d,
       COUNT(*) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text  AS calls_out_7d,
       COUNT(*) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '30 days')::text AS calls_out_30d,
       COUNT(*) FILTER (WHERE callee_id = $1 AND created_at > NOW() - INTERVAL '1 day')::text   AS calls_in_1d,
       COUNT(*) FILTER (WHERE callee_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text  AS calls_in_7d,
       COUNT(*) FILTER (WHERE callee_id = $1 AND created_at > NOW() - INTERVAL '30 days')::text AS calls_in_30d,
       COUNT(DISTINCT callee_id) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '1 day')::text   AS unique_callees_1d,
       COUNT(DISTINCT callee_id) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text  AS unique_callees_7d,
       COUNT(DISTINCT callee_id) FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '30 days')::text AS unique_callees_30d,
       COUNT(DISTINCT caller_id) FILTER (WHERE callee_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text  AS unique_callers_7d,
       AVG((status IN ('answered','ended'))::int)
         FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '1 day')::text    AS answer_rate_out_1d,
       AVG((status IN ('answered','ended'))::int)
         FILTER (WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text   AS answer_rate_out_7d,
       AVG((status IN ('answered','ended'))::int)
         FILTER (WHERE callee_id = $1 AND created_at > NOW() - INTERVAL '1 day')::text    AS answer_rate_in_1d,
       AVG((status IN ('answered','ended'))::int)
         FILTER (WHERE callee_id = $1 AND created_at > NOW() - INTERVAL '7 days')::text   AS answer_rate_in_7d,
       AVG(duration_seconds)
         FILTER (WHERE caller_id = $1 AND duration_seconds IS NOT NULL
                   AND created_at > NOW() - INTERVAL '7 days')::text                       AS avg_duration_7d,
       AVG((duration_seconds < 30)::int)
         FILTER (WHERE caller_id = $1 AND duration_seconds IS NOT NULL
                   AND created_at > NOW() - INTERVAL '7 days')::text                       AS pct_under_30s_7d
     FROM calls
     WHERE (caller_id = $1 OR callee_id = $1)
       AND created_at > NOW() - INTERVAL '30 days'`,
    [userId],
  );

  const n = (s: string | null | undefined, def = 0) => parseFloat(s ?? String(def)) || def;
  const i = (s: string | null | undefined, def = 0) => parseInt(s ?? String(def), 10) || def;

  const calls_out_1d = i(row?.calls_out_1d);
  const unique_callees_1d = i(row?.unique_callees_1d);

  // Trusted + reciprocal queries (small, run inline)
  const [trustedRow, reciprocalRow, newTargetsRow] = await Promise.all([
    queryOne<{ ratio: string | null }>(
      `SELECT AVG(
         EXISTS (
           SELECT 1 FROM connections
           WHERE owner_id = $1 AND contact_id = c.callee_id AND connection_type = 'trusted'
         )::int
       )::text AS ratio
       FROM calls c
       WHERE c.caller_id = $1 AND c.created_at > NOW() - INTERVAL '7 days'`,
      [userId],
    ),
    queryOne<{ total_callees: string; reciprocal_count: string }>(
      `WITH my_callees AS (
         SELECT DISTINCT callee_id FROM calls
         WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '30 days'
       )
       SELECT
         (SELECT COUNT(*) FROM my_callees)::text AS total_callees,
         COUNT(DISTINCT c.caller_id)::text AS reciprocal_count
       FROM calls c
       JOIN my_callees mc ON mc.callee_id = c.caller_id
       WHERE c.callee_id = $1 AND c.created_at > NOW() - INTERVAL '30 days'`,
      [userId],
    ),
    queryOne<{ new_targets: string }>(
      `SELECT COUNT(DISTINCT c1.callee_id)::text AS new_targets
       FROM calls c1
       WHERE c1.caller_id = $1
         AND c1.created_at > NOW() - INTERVAL '1 day'
         AND NOT EXISTS (
           SELECT 1 FROM calls c2
           WHERE c2.caller_id = $1 AND c2.callee_id = c1.callee_id
             AND c2.created_at < NOW() - INTERVAL '1 day'
             AND c2.created_at > NOW() - INTERVAL '30 days'
         )`,
      [userId],
    ),
  ]);

  const totalCallees = i(reciprocalRow?.total_callees);
  const reciprocalCount = i(reciprocalRow?.reciprocal_count);

  return {
    calls_out_1d,
    calls_out_7d:       i(row?.calls_out_7d),
    calls_out_30d:      i(row?.calls_out_30d),
    calls_in_1d:        i(row?.calls_in_1d),
    calls_in_7d:        i(row?.calls_in_7d),
    calls_in_30d:       i(row?.calls_in_30d),
    unique_callees_1d,
    unique_callees_7d:  i(row?.unique_callees_7d),
    unique_callees_30d: i(row?.unique_callees_30d),
    unique_callers_7d:  i(row?.unique_callers_7d),
    calls_per_unique_callee_1d: unique_callees_1d > 0 ? calls_out_1d / unique_callees_1d : 0,
    new_targets_1d:     i(newTargetsRow?.new_targets),
    answer_rate_out_1d: n(row?.answer_rate_out_1d),
    answer_rate_out_7d: n(row?.answer_rate_out_7d),
    answer_rate_in_1d:  n(row?.answer_rate_in_1d),
    answer_rate_in_7d:  n(row?.answer_rate_in_7d),
    avg_call_duration_7d:  n(row?.avg_duration_7d),
    pct_calls_under_30s_7d: n(row?.pct_under_30s_7d),
    reciprocal_rate_30d: totalCallees > 0 ? reciprocalCount / totalCallees : 0,
    calls_to_trusted_ratio_7d: n(trustedRow?.ratio),
  };
}

// ─── Behavioral patterns ──────────────────────────────────────────────────────

async function getBehavioralFeatures(userId: string) {
  const [burstRow, patternRow, sequentialRow, unknownRow] = await Promise.all([
    // Burst: days with >10 outgoing, plus this-week vs last-week acceleration
    queryOne<{ burst_count: string; this_week: string; last_week: string; repeat_calls: string; total_calls: string }>(
      `WITH daily AS (
         SELECT DATE(created_at) AS day, COUNT(*) AS cnt
         FROM calls WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days'
         GROUP BY DATE(created_at)
       ),
       weekly AS (
         SELECT
           COUNT(*) FILTER (WHERE created_at > NOW() - INTERVAL '7 days')  AS this_week,
           COUNT(*) FILTER (WHERE created_at BETWEEN NOW() - INTERVAL '14 days' AND NOW() - INTERVAL '7 days') AS last_week
         FROM calls WHERE caller_id = $1
       ),
       repeats AS (
         SELECT callee_id, COUNT(*) AS cnt FROM calls
         WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '7 days'
         GROUP BY callee_id
       )
       SELECT
         (SELECT COUNT(*) FROM daily WHERE cnt > 10)::text AS burst_count,
         w.this_week::text, w.last_week::text,
         SUM(GREATEST(0, r.cnt - 1))::text AS repeat_calls,
         SUM(r.cnt)::text AS total_calls
       FROM weekly w, repeats r
       GROUP BY w.this_week, w.last_week`,
      [userId],
    ),
    // Ghost ratio + consistent ignorers
    queryOne<{ ghost_count: string; total_multi: string; ignorer_count: string }>(
      `WITH callee_stats AS (
         SELECT
           callee_id,
           COUNT(*) AS total_calls,
           COUNT(*) FILTER (WHERE status IN ('answered','ended')) AS answered_count
         FROM calls
         WHERE caller_id = $1 AND created_at > NOW() - INTERVAL '30 days'
         GROUP BY callee_id
         HAVING COUNT(*) >= 2
       )
       SELECT
         COUNT(*) FILTER (WHERE answered_count = 1)::text AS ghost_count,
         COUNT(*)::text AS total_multi,
         COUNT(*) FILTER (WHERE answered_count = 0)::text AS ignorer_count
       FROM callee_stats`,
      [userId],
    ),
    // Sequential dialing: max unique callees in any 30-min window
    queryOne<{ seq_max: string }>(
      `WITH windows AS (
         SELECT c1.call_id,
           COUNT(DISTINCT c2.callee_id) AS callees_in_window
         FROM calls c1
         JOIN calls c2
           ON c2.caller_id = c1.caller_id
           AND c2.created_at BETWEEN c1.created_at AND c1.created_at + INTERVAL '30 minutes'
           AND c2.call_id != c1.call_id
         WHERE c1.caller_id = $1
           AND c1.created_at > NOW() - INTERVAL '7 days'
         GROUP BY c1.call_id
       )
       SELECT COALESCE(MAX(callees_in_window), 0)::text AS seq_max FROM windows`,
      [userId],
    ),
    // Unknown call ratio
    queryOne<{ unknown_calls: string; total_calls: string }>(
      `SELECT
         COUNT(*) FILTER (
           WHERE NOT EXISTS (
             SELECT 1 FROM connections cc
             WHERE cc.owner_id = c.callee_id AND cc.contact_id = c.caller_id
               AND cc.connection_type NOT IN ('unknown','blocked')
           )
         )::text AS unknown_calls,
         COUNT(*)::text AS total_calls
       FROM calls c
       WHERE c.caller_id = $1 AND c.created_at > NOW() - INTERVAL '7 days'`,
      [userId],
    ),
  ]);

  const n = (s: string | null | undefined, def = 0) => parseFloat(s ?? String(def)) || def;
  const i = (s: string | null | undefined, def = 0) => parseInt(s ?? String(def), 10) || def;

  const lastWeek = i(burstRow?.last_week);
  const thisWeek = i(burstRow?.this_week);
  const repeatCalls = i(burstRow?.repeat_calls);
  const totalCalls7d = i(burstRow?.total_calls);
  const ghostCount = i(patternRow?.ghost_count);
  const totalMulti = i(patternRow?.total_multi);
  const unknownCalls = i(unknownRow?.unknown_calls);
  const totalCalls = i(unknownRow?.total_calls);

  return {
    burst_count_7d:       i(burstRow?.burst_count),
    burst_acceleration:   lastWeek > 0 ? thisWeek / lastWeek : (thisWeek > 0 ? 5 : 1),
    repeat_call_rate_7d:  totalCalls7d > 0 ? repeatCalls / totalCalls7d : 0,
    sequential_dialing_max:     i(sequentialRow?.seq_max),
    first_contact_ghost_ratio_30d: totalMulti > 0 ? ghostCount / totalMulti : 0,
    consistent_ignorer_count_30d:  i(patternRow?.ignorer_count),
    unknown_call_ratio_7d: totalCalls > 0 ? unknownCalls / totalCalls : 0,
  };
}

// ─── Network ──────────────────────────────────────────────────────────────────

async function getNetworkFeatures(userId: string) {
  const [connRow, sharedRow] = await Promise.all([
    queryOne<{
      trusted_count: string;
      blocked_by_7d: string;
      blocked_by_30d: string;
      total_connections: string;
      avg_network_trust: string | null;
    }>(
      `SELECT
         COUNT(*) FILTER (WHERE owner_id = $1 AND connection_type = 'trusted')::text AS trusted_count,
         COUNT(*) FILTER (
           WHERE contact_id = $1 AND connection_type = 'blocked'
             AND updated_at > NOW() - INTERVAL '7 days'
         )::text AS blocked_by_7d,
         COUNT(*) FILTER (
           WHERE contact_id = $1 AND connection_type = 'blocked'
             AND updated_at > NOW() - INTERVAL '30 days'
         )::text AS blocked_by_30d,
         COUNT(DISTINCT CASE WHEN owner_id = $1 THEN contact_id END)::text AS total_connections,
         (SELECT AVG(u.trust_score)::text
          FROM connections c2
          JOIN users u ON u.user_id = c2.contact_id
          WHERE c2.owner_id = $1 AND c2.connection_type = 'trusted') AS avg_network_trust
       FROM connections
       WHERE owner_id = $1 OR contact_id = $1`,
      [userId],
    ),
    // Shared targets with accounts currently under review (coordinated spam signal)
    queryOne<{ shared_count: string }>(
      `SELECT COUNT(DISTINCT c1.callee_id)::text AS shared_count
       FROM calls c1
       WHERE c1.caller_id = $1
         AND c1.created_at > NOW() - INTERVAL '1 day'
         AND EXISTS (
           SELECT 1 FROM calls c2
           JOIN users u ON u.user_id = c2.caller_id
           WHERE c2.callee_id = c1.callee_id
             AND c2.caller_id != $1
             AND u.is_under_review = TRUE
             AND c2.created_at > NOW() - INTERVAL '1 day'
         )`,
      [userId],
    ),
  ]);

  const i = (s: string | null | undefined, def = 0) => parseInt(s ?? String(def), 10) || def;
  const n = (s: string | null | undefined, def = 0) => parseFloat(s ?? String(def)) || def;

  const trustedCount = i(connRow?.trusted_count);
  const blockedBy30 = i(connRow?.blocked_by_30d);
  const totalConn   = i(connRow?.total_connections);

  return {
    trusted_contacts_count:   trustedCount,
    blocked_by_7d:            i(connRow?.blocked_by_7d),
    blocked_by_30d:           blockedBy30,
    block_trusted_ratio:      (trustedCount + blockedBy30) > 0
                                ? blockedBy30 / (trustedCount + blockedBy30)
                                : 0,
    avg_trust_of_network:     n(connRow?.avg_network_trust),
    shared_targets_with_flagged: i(sharedRow?.shared_count),
  };
}

// ─── Trend ────────────────────────────────────────────────────────────────────

async function getTrendFeatures(userId: string) {
  const histRows = await query<{ new_score: number; created_at: string }>(
    `SELECT new_score, created_at FROM trust_score_history
     WHERE user_id = $1 AND created_at > NOW() - INTERVAL '14 days'
     ORDER BY created_at ASC`,
    [userId],
  );

  if (histRows.length < 2) {
    return { score_slope_7d: 0, behavior_regime: 'stable' as const };
  }

  // Linear regression slope (pts/day) over last 7d
  const recent = histRows.filter(r =>
    new Date(r.created_at) > new Date(Date.now() - 7 * 86400_000)
  );

  let slope = 0;
  if (recent.length >= 2) {
    const first = new Date(recent[0].created_at).getTime();
    const n = recent.length;
    const sumX = recent.reduce((s, r) =>
      s + (new Date(r.created_at).getTime() - first) / 86400_000, 0);
    const sumY = recent.reduce((s, r) => s + r.new_score, 0);
    const sumXY = recent.reduce((s, r) =>
      s + ((new Date(r.created_at).getTime() - first) / 86400_000) * r.new_score, 0);
    const sumX2 = recent.reduce((s, r) =>
      s + Math.pow((new Date(r.created_at).getTime() - first) / 86400_000, 2), 0);
    const denom = n * sumX2 - sumX * sumX;
    if (denom !== 0) slope = (n * sumXY - sumX * sumY) / denom;
  }

  // Regime classification
  const older = histRows.filter(r =>
    new Date(r.created_at) < new Date(Date.now() - 7 * 86400_000)
  );
  const oldAvg = older.length > 0
    ? older.reduce((s, r) => s + r.new_score, 0) / older.length
    : null;
  const recentAvg = recent.length > 0
    ? recent.reduce((s, r) => s + r.new_score, 0) / recent.length
    : null;

  let regime: 'stable' | 'escalating' | 'declining' | 'recovering' = 'stable';
  if (slope < -1.5) {
    regime = 'declining';
  } else if (slope > 1.5) {
    regime = oldAvg !== null && recentAvg !== null && oldAvg < 30 && recentAvg > oldAvg
      ? 'recovering'
      : 'escalating';   // score rising fast — could be legit or gaming
  }

  return {
    score_slope_7d:    Math.round(slope * 100) / 100,
    behavior_regime:   regime,
  };
}

// ─── Block context ─────────────────────────────────────────────────────────────

export async function extractBlockContext(
  blockerId: string,
  blockedId: string,
): Promise<BlockContext> {
  const [histRow, propensityRow, clusterRow, mutualRow] = await Promise.all([
    // Interaction history: calls from blocked→blocker (blocked was the caller)
    queryOne<{
      calls_count: string;
      days_known: string;
      block_speed_hours: string;
      answered_count: string;
      avg_duration: string | null;
    }>(
      `SELECT
         COUNT(*)::text AS calls_count,
         EXTRACT(DAY  FROM NOW() - MIN(created_at))::text AS days_known,
         EXTRACT(EPOCH FROM (NOW() - MIN(created_at)) / 3600)::text AS block_speed_hours,
         COUNT(*) FILTER (WHERE status IN ('answered','ended'))::text AS answered_count,
         AVG(duration_seconds) FILTER (WHERE duration_seconds IS NOT NULL)::text AS avg_duration
       FROM calls
       WHERE caller_id = $2 AND callee_id = $1`,
      [blockerId, blockedId],
    ),
    // How often does this blocker block people? (personal preference signal)
    queryOne<{ block_count: string; total_count: string }>(
      `SELECT
         COUNT(*) FILTER (WHERE connection_type = 'blocked')::text AS block_count,
         COUNT(*)::text AS total_count
       FROM connections WHERE owner_id = $1`,
      [blockerId],
    ),
    // Block cluster: how many others blocked the same person today?
    queryOne<{ cluster_count: string }>(
      `SELECT COUNT(DISTINCT owner_id)::text AS cluster_count
       FROM connections
       WHERE contact_id = $2
         AND connection_type = 'blocked'
         AND updated_at > NOW() - INTERVAL '24 hours'
         AND owner_id != $1`,
      [blockerId, blockedId],
    ),
    // Mutual calls: did the blocker ever call the blocked person?
    queryOne<{ mutual_count: string }>(
      `SELECT COUNT(*)::text AS mutual_count
       FROM calls WHERE caller_id = $1 AND callee_id = $2`,
      [blockerId, blockedId],
    ),
  ]);

  const i = (s: string | null | undefined, def = 0) => parseInt(s ?? String(def), 10) || def;
  const n = (s: string | null | undefined, def = 0) => parseFloat(s ?? String(def)) || def;

  const blockCount  = i(propensityRow?.block_count);
  const totalCount  = i(propensityRow?.total_count);

  // "was_ever_trusted" approximation: if they had >5 answered calls before block,
  // it implies a real relationship existed. True connection history not stored.
  const answeredBeforeBlock = i(histRow?.answered_count);
  const callsBeforeBlock    = i(histRow?.calls_count);

  return {
    blocker_id:               blockerId,
    blocked_id:               blockedId,
    calls_before_block:       callsBeforeBlock,
    days_known_before_block:  n(histRow?.days_known),
    was_ever_trusted:         answeredBeforeBlock >= 5,
    block_speed_hours:        n(histRow?.block_speed_hours),
    answered_before_block:    answeredBeforeBlock,
    avg_duration_before_block: n(histRow?.avg_duration),
    mutual_call_count:        i(mutualRow?.mutual_count),
    callee_block_propensity:  totalCount > 0 ? blockCount / totalCount : 0,
    block_cluster_24h:        i(clusterRow?.cluster_count),
  };
}
