/**
 * mlClient.ts — HTTP client for the PrivID ML inference service.
 *
 * The ML service is a separate Python/FastAPI process.
 * This module provides typed wrappers for all ML endpoints.
 *
 * Environment variables:
 *   ML_SERVICE_URL   base URL of the Python service  (default: http://localhost:8001)
 *   ML_API_KEY       shared secret sent as X-API-Key  (default: privid-ml-dev-key)
 *   ML_TIMEOUT_MS    per-request timeout in ms         (default: 3000)
 *
 * Fail-open design: if the ML service is unreachable or returns an error,
 * all functions return a safe default so the rule-based score is never blocked.
 */

import type { UserFeatures, BlockContext } from './featureStore';

// ─── Config ───────────────────────────────────────────────────────────────────

const ML_BASE   = process.env.ML_SERVICE_URL ?? 'http://localhost:8001';
const ML_KEY    = process.env.ML_API_KEY     ?? 'privid-ml-dev-key';
const ML_TIMEOUT = parseInt(process.env.ML_TIMEOUT_MS ?? '3000', 10);

// ─── Response types ───────────────────────────────────────────────────────────

export interface MLBlockIntentResult {
  label:        'personal_dispute' | 'spam_block' | 'harassment_block';
  p_personal:   number;
  p_spam:       number;
  p_harassment: number;
  weight:       number;
  penalty_pts:  number;
  confidence:   number;
  source:       string;
  latency_ms:   number;
}

export interface MLBehaviorDetail {
  label:            string;
  label_id:         number;
  probabilities:    number[];
  confidence:       number;
  spam_signals:     string[];
  harasser_signals: string[];
  source:           string;
}

export interface MLAnomalyDetail {
  is_anomaly:    boolean;
  anomaly_score: number;
  normalized:    number;
  percentile:    number;
  source:        string;
}

export interface MLScoreResult {
  user_id:             string;
  ml_score_delta:      number;
  override_review:     boolean;
  persona_prediction:  string;
  confidence:          number;
  model_agreement:     number;
  ml_flags:            string[];
  models: {
    behavior: MLBehaviorDetail;
    anomaly:  MLAnomalyDetail;
  };
  latency_ms: number;
}

export interface MLBatchScoreItem {
  user_id:             string;
  ml_score_delta:      number;
  override_review:     boolean;
  persona_prediction:  string;
  confidence:          number;
}

// ─── Safe defaults (returned when the ML service is unavailable) ───────────

const SAFE_BLOCK_INTENT: MLBlockIntentResult = {
  label:        'spam_block',
  p_personal:   0,
  p_spam:       1,
  p_harassment: 0,
  weight:       1.0,
  penalty_pts:  3.0,
  confidence:   0,
  source:       'fallback',
  latency_ms:   0,
};

const SAFE_SCORE: MLScoreResult = {
  user_id:            '',
  ml_score_delta:     0,
  override_review:    false,
  persona_prediction: 'unknown',
  confidence:         0,
  model_agreement:    0,
  ml_flags:           ['ML service unavailable — using rule-based score only'],
  models: {
    behavior: { label: 'unknown', label_id: 0, probabilities: [], confidence: 0, spam_signals: [], harasser_signals: [], source: 'fallback' },
    anomaly:  { is_anomaly: false, anomaly_score: 0, normalized: 0, percentile: 100, source: 'fallback' },
  },
  latency_ms: 0,
};

// ─── HTTP helper ─────────────────────────────────────────────────────────────

async function mlFetch<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timer      = setTimeout(() => controller.abort(), ML_TIMEOUT);

  try {
    const res = await fetch(`${ML_BASE}${path}`, {
      method:  'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    ML_KEY,
      },
      body:   JSON.stringify(body),
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      const text = await res.text().catch(() => res.statusText);
      throw new Error(`ML service error ${res.status}: ${text}`);
    }
    return res.json() as Promise<T>;
  } catch (err: any) {
    clearTimeout(timer);
    if (err.name === 'AbortError') {
      throw new Error(`ML service timeout after ${ML_TIMEOUT}ms`);
    }
    throw err;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify a single block event.
 * Returns a safe default (spam_block, weight=1.0) if the ML service is unavailable.
 */
export async function mlClassifyBlockIntent(ctx: BlockContext): Promise<MLBlockIntentResult> {
  try {
    return await mlFetch<MLBlockIntentResult>('/block-intent', {
      blocker_id:               ctx.blocker_id,
      blocked_id:               ctx.blocked_id,
      calls_before_block:       ctx.calls_before_block,
      days_known_before_block:  ctx.days_known_before_block,
      was_ever_trusted:         ctx.was_ever_trusted,
      block_speed_hours:        ctx.block_speed_hours,
      answered_before_block:    ctx.answered_before_block,
      avg_duration_before_block: ctx.avg_duration_before_block,
      mutual_call_count:        ctx.mutual_call_count,
      callee_block_propensity:  ctx.callee_block_propensity,
      block_cluster_24h:        ctx.block_cluster_24h,
    });
  } catch {
    return SAFE_BLOCK_INTENT;
  }
}

/**
 * Get ML score delta and behavioral analysis for a user.
 * Returns delta=0 if the ML service is unavailable (fail-open).
 */
export async function mlScoreUser(features: UserFeatures): Promise<MLScoreResult> {
  try {
    const payload: Record<string, unknown> = { user_id: features.user_id };
    // Copy all numeric/boolean feature fields
    const skip = new Set(['user_id', 'computed_at', 'behavior_regime',
                          'phone_verified', 'device_integrity', 'liveness_check',
                          'govt_id_verified', 'profile_completeness', 'account_age_days',
                          'score_slope_7d', 'regime_stable', 'regime_escalating',
                          'regime_declining', 'regime_recovering']);
    for (const [k, v] of Object.entries(features)) {
      if (!skip.has(k)) payload[k] = v;
    }
    return await mlFetch<MLScoreResult>('/score', payload);
  } catch {
    return { ...SAFE_SCORE, user_id: features.user_id };
  }
}

/**
 * Batch score multiple users.
 * Returns zero deltas for all users if the ML service is unavailable.
 */
export async function mlBatchScore(
  featuresList: UserFeatures[],
): Promise<MLBatchScoreItem[]> {
  if (featuresList.length === 0) return [];

  try {
    const users = featuresList.map((f) => {
      const payload: Record<string, unknown> = { user_id: f.user_id };
      const skip = new Set(['user_id', 'computed_at', 'behavior_regime',
                            'phone_verified', 'device_integrity', 'liveness_check',
                            'govt_id_verified', 'profile_completeness', 'account_age_days',
                            'score_slope_7d', 'regime_stable', 'regime_escalating',
                            'regime_declining', 'regime_recovering']);
      for (const [k, v] of Object.entries(f)) {
        if (!skip.has(k)) payload[k] = v;
      }
      return payload;
    });

    const res = await mlFetch<{ results: MLBatchScoreItem[] }>('/batch-score', { users });
    return res.results;
  } catch {
    return featuresList.map((f) => ({
      user_id:            f.user_id,
      ml_score_delta:     0,
      override_review:    false,
      persona_prediction: 'unknown',
      confidence:         0,
    }));
  }
}

/**
 * Check if the ML service is reachable and which models are trained.
 */
export async function mlHealthCheck(): Promise<{
  available: boolean;
  trained_models: number;
  source: string;
}> {
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 2000);
    const res = await fetch(`${ML_BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    if (!res.ok) return { available: false, trained_models: 0, source: 'unavailable' };
    const data = await res.json() as Record<string, any>;
    const trained = Object.values((data.models ?? {}) as Record<string, any>)
      .filter((m: any) => m.trained).length;
    return { available: true, trained_models: trained, source: 'ml-service' };
  } catch {
    return { available: false, trained_models: 0, source: 'unavailable' };
  }
}

/**
 * Send a confirmed label to the ML service for future retraining.
 */
export async function mlSendFeedback(
  userId: string,
  trueLabel: string,
  predictedLabel: string,
  features: Partial<UserFeatures>,
): Promise<void> {
  try {
    await mlFetch('/retrain-signal', {
      user_id:         userId,
      true_label:      trueLabel,
      predicted_label: predictedLabel,
      features,
    });
  } catch {
    // Best-effort — don't block on feedback
  }
}
