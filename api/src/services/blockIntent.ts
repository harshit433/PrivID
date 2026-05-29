/**
 * Block Intent Classifier — v1
 *
 * Classifies each block event into one of three intents:
 *   personal_dispute — was a real relationship, fell apart. Low penalty.
 *   spam_block       — cold caller, never wanted. Standard penalty.
 *   harassment_block — repeated unwanted contact. Heavy penalty.
 *
 * Current implementation: heuristic logistic-regression-style scoring.
 * The weights here are designed to match the ML model's expected outputs
 * so that when we wire in the ONNX model (Phase 3), it drops in
 * as a direct replacement for `heuristicClassify`.
 *
 * Training data generated via POST /simulation/export-training-data.
 */

import type { BlockContext } from './featureStore';

// ─── Output ───────────────────────────────────────────────────────────────────

export type BlockIntentLabel = 'personal_dispute' | 'spam_block' | 'harassment_block';

export interface BlockIntent {
  label:          BlockIntentLabel;
  p_personal:     number;   // 0–1
  p_spam:         number;
  p_harassment:   number;
  weight:         number;   // final penalty multiplier (0.1–2.0)
  signals:        string[]; // human-readable explanation for moderator
}

// ─── Penalty weights per intent type ─────────────────────────────────────────
// Applied as: actual_penalty = base_block_penalty × weight
// base_block_penalty = 3 pts (from TRUST_FACTOR_WEIGHTS)

const INTENT_WEIGHT: Record<BlockIntentLabel, number> = {
  personal_dispute:  0.1,   // almost no penalty — normal relationship friction
  spam_block:        1.0,   // full 3pt penalty as before
  harassment_block:  2.5,   // 7.5pt penalty — much stronger signal
};

// ─── Heuristic classifier ─────────────────────────────────────────────────────
//
// Each signal produces a log-odds contribution toward spam/harassment vs personal.
// Sum them, apply softmax-style normalization → probabilities.
//
// This structure mirrors a logistic regression model:
//   log_odds(spam) = w0 + w1*calls_before + w2*block_speed + ... + wN*cluster
//
// When the ML model is wired in, this function is replaced by ONNX inference
// but the output interface stays identical.

function heuristicClassify(ctx: BlockContext): {
  p_personal: number; p_spam: number; p_harassment: number; signals: string[];
} {
  let logOddsSpam        = 0;  // vs personal
  let logOddsHarassment  = 0;  // vs personal
  const signals: string[] = [];

  // ── Feature: calls_before_block ────────────────────────────────────────────
  // Spam: blocked immediately (0–2 calls). Personal: many prior calls.
  if (ctx.calls_before_block === 0) {
    logOddsSpam += 3.0;
    signals.push('blocked with no prior contact (cold block → spam)');
  } else if (ctx.calls_before_block <= 2) {
    logOddsSpam += 2.0;
    signals.push(`only ${ctx.calls_before_block} call(s) before block`);
  } else if (ctx.calls_before_block >= 10) {
    logOddsSpam -= 2.5;
    signals.push(`${ctx.calls_before_block} interactions before block (long relationship)`);
  }

  // ── Feature: answered_before_block ────────────────────────────────────────
  // If the blocker never answered, it signals the calls were unwanted.
  if (ctx.answered_before_block === 0 && ctx.calls_before_block >= 2) {
    logOddsSpam       += 1.5;
    logOddsHarassment += 1.0;
    signals.push('blocker never answered any call');
  } else if (ctx.answered_before_block >= 5) {
    logOddsSpam -= 2.0;
    signals.push(`${ctx.answered_before_block} calls were answered (willing participant)`);
  }

  // ── Feature: was_ever_trusted ─────────────────────────────────────────────
  if (ctx.was_ever_trusted) {
    logOddsSpam       -= 3.0;
    logOddsHarassment -= 1.0;
    signals.push('was previously in a trusted relationship (personal dispute)');
  }

  // ── Feature: block_speed_hours ────────────────────────────────────────────
  // Very quick block (<2h) after first contact = clear spam/harassment
  if (ctx.calls_before_block > 0 && ctx.block_speed_hours < 2) {
    logOddsSpam += 2.5;
    signals.push(`blocked within ${ctx.block_speed_hours.toFixed(1)}h of first contact`);
  } else if (ctx.block_speed_hours > 720) {  // >30 days
    logOddsSpam -= 1.5;
    signals.push('relationship lasted >30 days before block');
  }

  // ── Feature: calls_before_block concentration (harassment signal) ──────────
  // Many calls before block on a recent basis = harassment
  const daysKnown = Math.max(1, ctx.days_known_before_block);
  const callsPerDay = ctx.calls_before_block / daysKnown;
  if (callsPerDay >= 4 && ctx.calls_before_block >= 6) {
    logOddsHarassment += 2.5;
    signals.push(`high call rate: ${callsPerDay.toFixed(1)} calls/day before block`);
  } else if (callsPerDay >= 2 && ctx.calls_before_block >= 4) {
    logOddsHarassment += 1.0;
  }

  // ── Feature: avg_duration_before_block ────────────────────────────────────
  // Very short average duration = robocall / spam pattern
  if (ctx.avg_duration_before_block > 0 && ctx.avg_duration_before_block < 15) {
    logOddsSpam += 1.5;
    signals.push(`very short avg call duration (${ctx.avg_duration_before_block.toFixed(0)}s)`);
  } else if (ctx.avg_duration_before_block >= 60) {
    logOddsSpam -= 1.0;
    signals.push('meaningful call duration (real conversations happened)');
  }

  // ── Feature: mutual_call_count ────────────────────────────────────────────
  // If the "blocker" ever called the "blocked" person back, it's bilateral → personal
  if (ctx.mutual_call_count >= 3) {
    logOddsSpam -= 2.5;
    signals.push(`blocker called back ${ctx.mutual_call_count}× (bilateral relationship)`);
  } else if (ctx.mutual_call_count === 0 && ctx.calls_before_block >= 3) {
    logOddsSpam += 0.8;
    signals.push('no reciprocal calls from blocker (one-sided contact)');
  }

  // ── Feature: callee_block_propensity ─────────────────────────────────────
  // If this person blocks many people, their block is less meaningful as a spam signal
  if (ctx.callee_block_propensity >= 0.4) {
    logOddsSpam -= 1.5;
    signals.push(`blocker has high block rate (${(ctx.callee_block_propensity * 100).toFixed(0)}% of contacts) — discounted`);
  }

  // ── Feature: block_cluster_24h ────────────────────────────────────────────
  // Multiple different people blocking the same caller today = coordinated spam
  if (ctx.block_cluster_24h >= 5) {
    logOddsSpam       += 3.5;
    logOddsHarassment += 1.0;
    signals.push(`${ctx.block_cluster_24h} other people also blocked this caller today (coordinated signal)`);
  } else if (ctx.block_cluster_24h >= 2) {
    logOddsSpam += 1.5;
    signals.push(`${ctx.block_cluster_24h} others blocked this caller in 24h`);
  }

  // ── Softmax normalization ──────────────────────────────────────────────────
  // personal = baseline (log-odds = 0)
  const ePersonal    = Math.exp(0);
  const eSpam        = Math.exp(Math.min(logOddsSpam, 8));
  const eHarassment  = Math.exp(Math.min(logOddsHarassment, 8));
  const total        = ePersonal + eSpam + eHarassment;

  return {
    p_personal:   ePersonal   / total,
    p_spam:       eSpam       / total,
    p_harassment: eHarassment / total,
    signals,
  };
}

// ─── Public API ───────────────────────────────────────────────────────────────

export function classifyBlockIntent(ctx: BlockContext): BlockIntent {
  const { p_personal, p_spam, p_harassment, signals } = heuristicClassify(ctx);

  // Dominant class
  let label: BlockIntentLabel;
  if (p_personal >= p_spam && p_personal >= p_harassment) {
    label = 'personal_dispute';
  } else if (p_spam >= p_harassment) {
    label = 'spam_block';
  } else {
    label = 'harassment_block';
  }

  // Weight is the dominant class's multiplier, blended toward spam signal
  // when we're uncertain (entropy is high)
  const entropy = -(
    (p_personal > 0 ? p_personal * Math.log(p_personal) : 0) +
    (p_spam     > 0 ? p_spam     * Math.log(p_spam)     : 0) +
    (p_harassment > 0 ? p_harassment * Math.log(p_harassment) : 0)
  );
  const maxEntropy = Math.log(3);
  const certainty  = 1 - entropy / maxEntropy;  // 0=uncertain, 1=certain

  const baseWeight = INTENT_WEIGHT[label];
  // When uncertain, blend toward spam_block weight (conservative)
  const weight = certainty * baseWeight + (1 - certainty) * INTENT_WEIGHT.spam_block;

  return {
    label,
    p_personal,
    p_spam,
    p_harassment,
    weight: Math.round(weight * 100) / 100,
    signals,
  };
}

// ─── Penalty calculation ──────────────────────────────────────────────────────
//
// Use this in the trust score engine instead of the flat "-3 per block" formula.
// Returns the actual pts to subtract for a single block event.

export function blockPenaltyPts(intent: BlockIntent): number {
  const BASE_BLOCK_PTS = 3;
  return Math.round(BASE_BLOCK_PTS * intent.weight * 10) / 10;
}
