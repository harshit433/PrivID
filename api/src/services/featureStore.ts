/**
 * TrustRoute Feature Store — v1
 *
 * Extracts ~45 behavioral features for a user, used by:
 *   - ML trust score models (Python inference service)
 *   - Training data export for model retraining
 *
 * All features are computed from PostgreSQL and are point-in-time snapshots.
 * Hot path (per-call scoring) uses a subset; full extraction is for batch scoring.
 */

import { query, queryOne } from '@trustroute/shared';

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

// ─── Main extraction ───────────────────────────────────────────────────────────

export async function extractFeatures(userId: string, asOf?: Date | string): Promise<UserFeatures> {
  if (asOf) {
    const [features] = await bulkExtractFeatures([userId], asOf);
    if (features) return features;
  }

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
    // Sequential dialing: max unique callees in any 30-min window (LATERAL scan per anchor time)
    queryOne<{ seq_max: string }>(
      `SELECT COALESCE(MAX(w.cnt), 0)::text AS seq_max
       FROM (
         SELECT DISTINCT created_at AS anchor_at
         FROM calls
         WHERE caller_id = $1
           AND created_at > NOW() - INTERVAL '7 days'
       ) anchors
       CROSS JOIN LATERAL (
         SELECT COUNT(DISTINCT callee_id) AS cnt
         FROM calls c
         WHERE c.caller_id = $1
           AND c.created_at BETWEEN anchors.anchor_at AND anchors.anchor_at + INTERVAL '30 minutes'
       ) w`,
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

// ─── Bulk, as-of extraction (simulation / backtesting) ────────────────────────
//
// Additive, self-contained path — does NOT touch the production hot path above.
// Computes the full behavioral feature set for a *batch* of users, relative to a
// caller-supplied reference time (`asOf`, default = now). This makes point-in-time
// ("as of virtual day N") scoring possible for the time-series simulator and any
// future audit/backtest use.
//
// The ML service (`mlBatchScore`) only consumes volume / quality / behavioral /
// network numeric features — identity + trend fields are skipped in its payload —
// so those are defaulted here to keep the SQL lean. Verification points are added
// by the caller (see simEngine/recompute).

export async function bulkExtractFeatures(
  userIds: string[],
  asOf?: Date | string,
): Promise<UserFeatures[]> {
  if (userIds.length === 0) return [];
  const ref = asOf ? new Date(asOf).toISOString() : new Date().toISOString();

  // ── Volume + quality (out by caller, in by callee) ─────────────────────────
  const volRows = await query<Record<string, string | null>>(
    `WITH
       out_c AS (
         SELECT caller_id AS uid,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 day')   AS o1,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days')  AS o7,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '30 days') AS o30,
           COUNT(DISTINCT callee_id) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 day')   AS uc1,
           COUNT(DISTINCT callee_id) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days')  AS uc7,
           COUNT(DISTINCT callee_id) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '30 days') AS uc30,
           AVG(CASE WHEN status IN ('answered','ended') THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 day')  AS ar1,
           AVG(CASE WHEN status IN ('answered','ended') THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days') AS ar7,
           AVG(duration_seconds)
             FILTER (WHERE duration_seconds IS NOT NULL AND created_at > $2::timestamptz - INTERVAL '7 days') AS avgdur7,
           AVG(CASE WHEN duration_seconds < 30 THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE duration_seconds IS NOT NULL AND created_at > $2::timestamptz - INTERVAL '7 days') AS pct30_7
         FROM calls
         WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '30 days'
         GROUP BY caller_id
       ),
       in_c AS (
         SELECT callee_id AS uid,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 day')   AS i1,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days')  AS i7,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '30 days') AS i30,
           COUNT(DISTINCT caller_id) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days') AS ur7,
           AVG(CASE WHEN status IN ('answered','ended') THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE created_at > $2::timestamptz - INTERVAL '1 day')  AS arin1,
           AVG(CASE WHEN status IN ('answered','ended') THEN 1.0 ELSE 0.0 END)
             FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days') AS arin7
         FROM calls
         WHERE callee_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '30 days'
         GROUP BY callee_id
       )
     SELECT u.user_id,
       COALESCE(out_c.o1,0)::text o1, COALESCE(out_c.o7,0)::text o7, COALESCE(out_c.o30,0)::text o30,
       COALESCE(out_c.uc1,0)::text uc1, COALESCE(out_c.uc7,0)::text uc7, COALESCE(out_c.uc30,0)::text uc30,
       out_c.ar1::text ar1, out_c.ar7::text ar7, COALESCE(out_c.avgdur7,0)::text avgdur7, COALESCE(out_c.pct30_7,0)::text pct30_7,
       COALESCE(in_c.i1,0)::text i1, COALESCE(in_c.i7,0)::text i7, COALESCE(in_c.i30,0)::text i30,
       COALESCE(in_c.ur7,0)::text ur7, in_c.arin1::text arin1, in_c.arin7::text arin7
     FROM users u
     LEFT JOIN out_c ON out_c.uid = u.user_id
     LEFT JOIN in_c  ON in_c.uid  = u.user_id
     WHERE u.user_id = ANY($1)`,
    [userIds, ref],
  );

  // ── Behavioral patterns ────────────────────────────────────────────────────
  const behRows = await query<Record<string, string | null>>(
    `WITH
       daily AS (
         SELECT caller_id AS uid, date_trunc('day', created_at) d, COUNT(*) c
         FROM calls WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '7 days'
         GROUP BY caller_id, date_trunc('day', created_at)
       ),
       burst AS (SELECT uid, COUNT(*) FILTER (WHERE c > 10) burst_count FROM daily GROUP BY uid),
       weekly AS (
         SELECT caller_id AS uid,
           COUNT(*) FILTER (WHERE created_at > $2::timestamptz - INTERVAL '7 days') this_week,
           COUNT(*) FILTER (WHERE created_at BETWEEN $2::timestamptz - INTERVAL '14 days' AND $2::timestamptz - INTERVAL '7 days') last_week
         FROM calls WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '14 days'
         GROUP BY caller_id
       ),
       repeats AS (
         SELECT caller_id AS uid, callee_id, COUNT(*) c
         FROM calls WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '7 days'
         GROUP BY caller_id, callee_id
       ),
       repeat_agg AS (SELECT uid, SUM(GREATEST(0, c - 1)) rc, SUM(c) tc FROM repeats GROUP BY uid),
       seq AS (
         SELECT uid, MAX(cnt) seq_max FROM (
           SELECT caller_id AS uid,
             floor(extract(epoch FROM created_at) / 1800) bucket,
             COUNT(DISTINCT callee_id) cnt
           FROM calls WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '7 days'
           GROUP BY caller_id, bucket
         ) s GROUP BY uid
       ),
       callee_stats AS (
         SELECT caller_id AS uid, callee_id,
           COUNT(*) total,
           COUNT(*) FILTER (WHERE status IN ('answered','ended')) answered
         FROM calls WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '30 days'
         GROUP BY caller_id, callee_id HAVING COUNT(*) >= 2
       ),
       ghost AS (
         SELECT uid,
           COUNT(*) FILTER (WHERE answered = 1) ghost_count,
           COUNT(*) total_multi,
           COUNT(*) FILTER (WHERE answered = 0) ignorer_count
         FROM callee_stats GROUP BY uid
       ),
       unk AS (
         SELECT c.caller_id AS uid,
           COUNT(*) FILTER (WHERE NOT EXISTS (
             SELECT 1 FROM connections cc
             WHERE cc.owner_id = c.callee_id AND cc.contact_id = c.caller_id
               AND cc.connection_type NOT IN ('unknown','blocked')
           )) unknown_calls,
           COUNT(*) total_calls
         FROM calls c WHERE c.caller_id = ANY($1) AND c.created_at > $2::timestamptz - INTERVAL '7 days'
         GROUP BY c.caller_id
       ),
       newt AS (
         SELECT c1.caller_id AS uid, COUNT(DISTINCT c1.callee_id) new_targets
         FROM calls c1
         WHERE c1.caller_id = ANY($1) AND c1.created_at > $2::timestamptz - INTERVAL '1 day'
           AND NOT EXISTS (
             SELECT 1 FROM calls c2 WHERE c2.caller_id = c1.caller_id AND c2.callee_id = c1.callee_id
               AND c2.created_at < $2::timestamptz - INTERVAL '1 day'
               AND c2.created_at > $2::timestamptz - INTERVAL '30 days'
           )
         GROUP BY c1.caller_id
       ),
       tratio AS (
         SELECT c.caller_id AS uid,
           AVG(CASE WHEN EXISTS (
             SELECT 1 FROM connections cn WHERE cn.owner_id = c.caller_id
               AND cn.contact_id = c.callee_id AND cn.connection_type = 'trusted'
           ) THEN 1.0 ELSE 0.0 END) ratio
         FROM calls c WHERE c.caller_id = ANY($1) AND c.created_at > $2::timestamptz - INTERVAL '7 days'
         GROUP BY c.caller_id
       ),
       my_callees AS (
         SELECT DISTINCT caller_id AS uid, callee_id
         FROM calls WHERE caller_id = ANY($1) AND created_at > $2::timestamptz - INTERVAL '30 days'
       ),
       recip AS (
         SELECT mc.uid, COUNT(*) total_callees,
           COUNT(*) FILTER (WHERE EXISTS (
             SELECT 1 FROM calls cb WHERE cb.caller_id = mc.callee_id AND cb.callee_id = mc.uid
               AND cb.created_at > $2::timestamptz - INTERVAL '30 days'
           )) recip_count
         FROM my_callees mc GROUP BY mc.uid
       )
     SELECT u.user_id,
       COALESCE(burst.burst_count,0)::text burst_count,
       COALESCE(weekly.this_week,0)::text this_week, COALESCE(weekly.last_week,0)::text last_week,
       COALESCE(repeat_agg.rc,0)::text rc, COALESCE(repeat_agg.tc,0)::text tc,
       COALESCE(seq.seq_max,0)::text seq_max,
       COALESCE(ghost.ghost_count,0)::text ghost_count, COALESCE(ghost.total_multi,0)::text total_multi,
       COALESCE(ghost.ignorer_count,0)::text ignorer_count,
       COALESCE(unk.unknown_calls,0)::text unknown_calls, COALESCE(unk.total_calls,0)::text total_calls,
       COALESCE(newt.new_targets,0)::text new_targets,
       COALESCE(tratio.ratio,0)::text tratio,
       COALESCE(recip.total_callees,0)::text total_callees, COALESCE(recip.recip_count,0)::text recip_count
     FROM users u
     LEFT JOIN burst      ON burst.uid = u.user_id
     LEFT JOIN weekly     ON weekly.uid = u.user_id
     LEFT JOIN repeat_agg ON repeat_agg.uid = u.user_id
     LEFT JOIN seq        ON seq.uid = u.user_id
     LEFT JOIN ghost      ON ghost.uid = u.user_id
     LEFT JOIN unk        ON unk.uid = u.user_id
     LEFT JOIN newt       ON newt.uid = u.user_id
     LEFT JOIN tratio     ON tratio.uid = u.user_id
     LEFT JOIN recip      ON recip.uid = u.user_id
     WHERE u.user_id = ANY($1)`,
    [userIds, ref],
  );

  // ── Network ────────────────────────────────────────────────────────────────
  const netRows = await query<Record<string, string | null>>(
    `WITH
       trusted AS (
         SELECT owner_id AS uid, COUNT(*) trusted_count
         FROM connections WHERE owner_id = ANY($1) AND connection_type = 'trusted'
         GROUP BY owner_id
       ),
       blocked AS (
         SELECT contact_id AS uid,
           COUNT(*) FILTER (WHERE updated_at > $2::timestamptz - INTERVAL '7 days')  b7,
           COUNT(*) FILTER (WHERE updated_at > $2::timestamptz - INTERVAL '30 days') b30
         FROM connections WHERE contact_id = ANY($1) AND connection_type = 'blocked'
         GROUP BY contact_id
       ),
       netavg AS (
         SELECT c.owner_id AS uid, AVG(us.trust_score) avg_trust
         FROM connections c JOIN users us ON us.user_id = c.contact_id
         WHERE c.owner_id = ANY($1) AND c.connection_type = 'trusted'
         GROUP BY c.owner_id
       ),
       shared AS (
         SELECT c1.caller_id AS uid, COUNT(DISTINCT c1.callee_id) shared_count
         FROM calls c1
         WHERE c1.caller_id = ANY($1) AND c1.created_at > $2::timestamptz - INTERVAL '1 day'
           AND EXISTS (
             SELECT 1 FROM calls c2 JOIN users u2 ON u2.user_id = c2.caller_id
             WHERE c2.callee_id = c1.callee_id AND c2.caller_id <> c1.caller_id
               AND u2.is_under_review = TRUE
               AND c2.created_at > $2::timestamptz - INTERVAL '1 day'
           )
         GROUP BY c1.caller_id
       )
     SELECT u.user_id,
       COALESCE(trusted.trusted_count,0)::text trusted_count,
       COALESCE(blocked.b7,0)::text b7, COALESCE(blocked.b30,0)::text b30,
       COALESCE(netavg.avg_trust,0)::text avg_trust,
       COALESCE(shared.shared_count,0)::text shared_count
     FROM users u
     LEFT JOIN trusted ON trusted.uid = u.user_id
     LEFT JOIN blocked ON blocked.uid = u.user_id
     LEFT JOIN netavg  ON netavg.uid  = u.user_id
     LEFT JOIN shared  ON shared.uid  = u.user_id
     WHERE u.user_id = ANY($1)`,
    [userIds, ref],
  );

  const num = (s: string | null | undefined, def = 0) => (s == null ? def : parseFloat(s) || def);
  const vol = new Map(volRows.map(r => [r.user_id as string, r]));
  const beh = new Map(behRows.map(r => [r.user_id as string, r]));
  const net = new Map(netRows.map(r => [r.user_id as string, r]));
  const nowIso = new Date().toISOString();

  return userIds.map((uid) => {
    const v = vol.get(uid) ?? {};
    const b = beh.get(uid) ?? {};
    const nw = net.get(uid) ?? {};

    const o1 = num(v.o1), uc1 = num(v.uc1);
    const thisWeek = num(b.this_week), lastWeek = num(b.last_week);
    const rc = num(b.rc), tc = num(b.tc);
    const ghostCount = num(b.ghost_count), totalMulti = num(b.total_multi);
    const unknownCalls = num(b.unknown_calls), totalCalls = num(b.total_calls);
    const totalCallees = num(b.total_callees), recipCount = num(b.recip_count);
    const trustedCount = num(nw.trusted_count), blocked30 = num(nw.b30);

    return {
      user_id: uid,
      computed_at: nowIso,
      // Identity + trend: defaulted (skipped by the ML payload); verification
      // points are applied separately by the caller.
      phone_verified: false, device_integrity: false, liveness_check: false,
      govt_id_verified: false, profile_completeness: 0, account_age_days: 0,
      // Volume
      calls_out_1d: o1, calls_out_7d: num(v.o7), calls_out_30d: num(v.o30),
      calls_in_1d: num(v.i1), calls_in_7d: num(v.i7), calls_in_30d: num(v.i30),
      unique_callees_1d: uc1, unique_callees_7d: num(v.uc7), unique_callees_30d: num(v.uc30),
      unique_callers_7d: num(v.ur7),
      calls_per_unique_callee_1d: uc1 > 0 ? o1 / uc1 : 0,
      new_targets_1d: num(b.new_targets),
      // Quality
      answer_rate_out_1d: num(v.ar1, 1), answer_rate_out_7d: num(v.ar7, 1),
      answer_rate_in_1d: num(v.arin1, 1), answer_rate_in_7d: num(v.arin7, 1),
      avg_call_duration_7d: num(v.avgdur7), pct_calls_under_30s_7d: num(v.pct30_7),
      reciprocal_rate_30d: totalCallees > 0 ? recipCount / totalCallees : 0,
      calls_to_trusted_ratio_7d: num(b.tratio),
      // Behavioral
      unknown_call_ratio_7d: totalCalls > 0 ? unknownCalls / totalCalls : 0,
      burst_count_7d: num(b.burst_count),
      burst_acceleration: lastWeek > 0 ? thisWeek / lastWeek : (thisWeek > 0 ? 5 : 1),
      repeat_call_rate_7d: tc > 0 ? rc / tc : 0,
      sequential_dialing_max: num(b.seq_max),
      first_contact_ghost_ratio_30d: totalMulti > 0 ? ghostCount / totalMulti : 0,
      consistent_ignorer_count_30d: num(b.ignorer_count),
      // Network
      trusted_contacts_count: trustedCount,
      blocked_by_7d: num(nw.b7), blocked_by_30d: blocked30,
      block_trusted_ratio: (trustedCount + blocked30) > 0 ? blocked30 / (trustedCount + blocked30) : 0,
      avg_trust_of_network: num(nw.avg_trust),
      shared_targets_with_flagged: num(nw.shared_count),
      // Trend: defaulted (skipped by ML payload)
      score_slope_7d: 0,
      behavior_regime: 'stable',
    };
  });
}

