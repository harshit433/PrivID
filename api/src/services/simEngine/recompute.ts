/**
 * Time-series simulation — as-of trust recompute (the real ML pipeline).
 *
 * For a set of affected users at virtual time `asOf`:
 *   1. bulkExtractFeatures(asOf)  → the real behavioural feature set
 *   2. mlBatchScore               → the real Python ensemble (ml_score_delta, etc.)
 *   3. score = clamp(verification_pts + ml_delta); persist + trust_score_history
 *   4. auto-review on ML override or first drop < REVIEW_THRESHOLD
 *
 * Verification points == the account's seeded base_score (our accounts have no
 * avatar → no profile point, and age < 180d → 0 age points), so we avoid a
 * redundant per-tick verification query.
 */

import { query } from '@trustroute/shared';
import { scoreToTier, clampScore, REVIEW_THRESHOLD } from '@trustroute/shared';
import { bulkExtractFeatures } from '../featureStore';
import { mlBatchScore } from '../mlClient';
import type { SimAccount } from './personas';

export interface RecomputeResult {
  user_id: string;
  persona: string;
  base: number;
  ml_delta: number;
  score: number;
  prev_score: number;
  tier: string;
  persona_prediction: string;
  confidence: number;
  override_review: boolean;
  under_review: boolean;      // is the account under review AFTER this tick
  newly_flagged: boolean;     // did it transition into review this tick
}

/** Mirror production mass-outreach thresholds as-of virtual time (no worker enqueue). */
async function flagMassOutreachAsOf(userIds: string[], asOfIso: string): Promise<void> {
  if (userIds.length === 0) return;
  const rows = await query<{
    caller_id: string; unique_callees: string; total_calls: string; declined: string;
  }>(
    `SELECT caller_id,
            COUNT(DISTINCT callee_id)::text AS unique_callees,
            COUNT(*)::text AS total_calls,
            COUNT(*) FILTER (WHERE status = 'declined')::text AS declined
       FROM calls
      WHERE caller_id = ANY($1)
        AND created_at > $2::timestamptz - INTERVAL '60 minutes'
        AND created_at <= $2::timestamptz
      GROUP BY caller_id`,
    [userIds, asOfIso],
  );
  for (const r of rows) {
    const uniqueCallees = parseInt(r.unique_callees, 10);
    const totalCalls = parseInt(r.total_calls, 10);
    const declined = parseInt(r.declined, 10);
    const declineRate = totalCalls >= 5 ? declined / totalCalls : 0;
    const flagged = uniqueCallees > 15 || totalCalls > 20 || declineRate > 0.7;
    if (!flagged) continue;
    await query(
      `INSERT INTO behavior_events (user_id, event_type, metadata, created_at)
       VALUES ($1, 'mass_outreach_flag', $2, $3::timestamptz)`,
      [r.caller_id, JSON.stringify({ uniqueCallees, totalCalls, declineRate }), asOfIso],
    );
  }
}

export async function recomputeAsOf(
  userIds: string[],
  asOf: Date,
  byId: Map<string, SimAccount>,
): Promise<RecomputeResult[]> {
  if (userIds.length === 0) return [];
  const asOfIso = asOf.toISOString();

  await flagMassOutreachAsOf(userIds, asOfIso);

  const flagRows = await query<{ user_id: string; c: string }>(
    `SELECT user_id, COUNT(*)::text AS c
       FROM behavior_events
      WHERE user_id = ANY($1) AND event_type = 'mass_outreach_flag'
      GROUP BY user_id`,
    [userIds],
  );
  const outreachFlags = new Map(flagRows.map(r => [r.user_id, parseInt(r.c, 10)]));

  // Current persisted state for the batch.
  const cur = await query<{ user_id: string; trust_score: number; trust_tier: string; is_under_review: boolean }>(
    `SELECT user_id, trust_score, trust_tier, is_under_review FROM users WHERE user_id = ANY($1)`,
    [userIds],
  );
  const curMap = new Map(cur.map(r => [r.user_id, r]));

  // Real feature extraction (as-of) + real ML batch scoring.
  const features = await bulkExtractFeatures(userIds, asOf);
  const ml = await mlBatchScore(features);
  const mlMap = new Map(ml.map(m => [m.user_id, m]));

  const results: RecomputeResult[] = [];
  const flaggedNow: string[] = [];
  const changed: RecomputeResult[] = [];

  for (const uid of userIds) {
    const acct = byId.get(uid);
    const base = acct?.base_score ?? (curMap.get(uid)?.trust_score ?? 0);
    const m = mlMap.get(uid);
    const delta = m?.ml_score_delta ?? 0;
    const score = clampScore(base + delta);
    const tier = scoreToTier(score);
    const prev = curMap.get(uid);
    const prevScore = prev?.trust_score ?? base;
    const wasReviewed = prev?.is_under_review ?? false;

    const override = m?.override_review ?? false;
    const droppedBelow = score < REVIEW_THRESHOLD && prevScore >= REVIEW_THRESHOLD;
    const massOutreach = (outreachFlags.get(uid) ?? 0) >= 2;
    const newlyFlagged = !wasReviewed && (override || droppedBelow || massOutreach);
    const underReview = wasReviewed || newlyFlagged;

    const r: RecomputeResult = {
      user_id: uid, persona: acct?.persona ?? 'unknown', base, ml_delta: delta,
      score, prev_score: prevScore, tier,
      persona_prediction: m?.persona_prediction ?? 'unknown', confidence: m?.confidence ?? 0,
      override_review: override, under_review: underReview, newly_flagged: newlyFlagged,
    };
    results.push(r);
    if (newlyFlagged) flaggedNow.push(uid);
    if (score !== prevScore || tier !== prev?.trust_tier || newlyFlagged) changed.push(r);
  }

  // Batch UPDATE trust_score/tier via CASE.
  for (const batch of chunk(changed, 200)) {
    const caseScore = batch.map((r, j) => `WHEN $${j * 3 + 1}::uuid THEN $${j * 3 + 2}::int`).join(' ');
    const caseTier = batch.map((r, j) => `WHEN $${j * 3 + 1}::uuid THEN $${j * 3 + 3}::trust_tier`).join(' ');
    const args = batch.flatMap(r => [r.user_id, r.score, r.tier]);
    await query(
      `UPDATE users SET trust_score = CASE user_id ${caseScore} END,
                        trust_tier  = CASE user_id ${caseTier} END
       WHERE user_id = ANY($${args.length + 1}::uuid[])`,
      [...args, batch.map(r => r.user_id)],
    );
  }

  // Auto-review flag for newly flagged.
  if (flaggedNow.length) {
    await query(
      `UPDATE users SET is_under_review = TRUE, review_reason = 'tsim: abnormal pattern', review_started_at = $2::timestamptz
       WHERE user_id = ANY($1) AND is_under_review = FALSE`,
      [flaggedNow, asOfIso],
    );
  }

  // trust_score_history for score/tier changes (created_at = virtual time).
  const hist = changed.filter(r => r.score !== r.prev_score || byId.has(r.user_id));
  for (const batch of chunk(hist, 200)) {
    const cols: string[] = []; const args: unknown[] = [];
    batch.forEach((r, j) => {
      const b = j * 6;
      const prevTier = scoreToTier(r.prev_score);
      cols.push(`($${b+1},$${b+2},$${b+3},$${b+4}::trust_tier,$${b+5}::trust_tier,'tsim',$${b+6}::timestamptz)`);
      args.push(r.user_id, r.prev_score, r.score, prevTier, r.tier, asOfIso);
    });
    if (cols.length) {
      await query(
        `INSERT INTO trust_score_history (user_id, old_score, new_score, old_tier, new_tier, reason, created_at) VALUES ${cols.join(',')}`,
        args,
      );
    }
  }

  return results;
}

function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}
