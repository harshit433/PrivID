/**
 * worker/src/utils/mlClient.ts
 *
 * Lean ML client for the background worker.
 *
 * The worker uses the ML service's /score-by-id/{user_id} endpoint, which
 * handles feature extraction from the DB internally. This avoids the worker
 * needing to re-implement the full featureStore.ts logic.
 *
 * Fail-open: if the ML service is unreachable, returns null (caller applies 0
 * modifier so the score degrades gracefully to verification-only).
 *
 * Environment:
 *   ML_SERVICE_URL   base URL of the Python ML service (default: http://localhost:8001)
 *   ML_API_KEY       shared secret (default: trustroute-ml-dev-key)
 *   ML_TIMEOUT_MS    per-request timeout in ms (default: 5000 — higher than the API
 *                    because the worker is async and latency-tolerant)
 */

const ML_BASE    = process.env.ML_SERVICE_URL ?? 'http://localhost:8001';
const ML_KEY     = process.env.ML_API_KEY     ?? 'trustroute-ml-dev-key';
const ML_TIMEOUT = parseInt(process.env.ML_TIMEOUT_MS ?? '5000', 10);

export interface MLDelta {
  user_id:            string;
  ml_score_delta:     number;   // range [-40, +10]
  override_review:    boolean;
  persona_prediction: string;
  confidence:         number;
  ml_flags:           string[];
}

/**
 * scoreByUserId — call the ML service to score a user by their ID.
 * The ML service fetches features from the shared Postgres DB.
 *
 * Returns null if the ML service is unreachable or returns an error.
 */
export async function scoreByUserId(userId: string): Promise<MLDelta | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ML_TIMEOUT);

  try {
    const res = await fetch(`${ML_BASE}/score-by-id/${encodeURIComponent(userId)}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-API-Key':    ML_KEY,
      },
      signal: controller.signal,
    });

    clearTimeout(timer);

    if (!res.ok) {
      return null;
    }

    const data = await res.json() as MLDelta;
    return data;
  } catch (err: any) {
    clearTimeout(timer);
    // AbortError = timeout; network error = service down — both are fail-open
    return null;
  }
}

/**
 * isMLAvailable — quick health probe, used on worker startup.
 */
export async function isMLAvailable(): Promise<boolean> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const res = await fetch(`${ML_BASE}/health`, { signal: controller.signal });
    clearTimeout(timer);
    return res.ok;
  } catch {
    clearTimeout(timer);
    return false;
  }
}
