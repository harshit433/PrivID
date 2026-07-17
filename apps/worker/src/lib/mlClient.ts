/**
 * Thin HTTP client for the optional ML behavioural-scoring service. The service is
 * dev/optional: when `ML_SERVICE_URL` is unset (production without ML, or plain dev),
 * every call fails open — trust recompute then applies the verification-only score and
 * the ML-feedback job simply skips. Never throws; a null result means "ML unavailable".
 */
import { config, logger } from '@trustroute/core';

export interface MlScoreDelta {
  ml_score_delta: number;
  persona_prediction: string;
  confidence: number;
  override_review: boolean;
  ml_flags?: string[];
}

async function post<T>(path: string, body: unknown): Promise<T | null> {
  const base = config.ML_SERVICE_URL;
  if (!base) return null;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.ML_TIMEOUT_MS);
  try {
    const resp = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-API-Key': config.ML_API_KEY ?? '' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!resp.ok) {
      logger.warn('ml', `${path} rejected`, { status: resp.status });
      return null;
    }
    return (await resp.json()) as T;
  } catch (err) {
    logger.warn('ml', `${path} unreachable`, { error: (err as Error).message });
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Behavioural score delta for a user; null when ML is unavailable. */
export function scoreByUserId(userId: string): Promise<MlScoreDelta | null> {
  return post<MlScoreDelta>('/score', { user_id: userId });
}

/** Submit a ground-truth retrain signal; returns false when ML is unavailable. */
export async function sendRetrainSignal(input: {
  userId: string;
  trueLabel: string;
  predictedLabel: string;
  features: Record<string, unknown>;
}): Promise<boolean> {
  const res = await post<{ ok: boolean }>('/retrain-signal', {
    user_id: input.userId,
    true_label: input.trueLabel,
    predicted_label: input.predictedLabel,
    features: input.features,
  });
  return res !== null;
}
