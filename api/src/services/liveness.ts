import axios from 'axios';

// ─── Managed passive liveness (Luxand.cloud) ─────────────────────────────────
// The client captures a single selfie frame and uploads it; we forward the image
// to Luxand's liveness endpoint, which returns whether the face is a live person
// or a spoof (photo/screen). This is passive liveness: no on-device model, no
// streaming, no per-region setup — just one HTTPS call that returns in <1s.
//
// Get a free token at https://luxand.cloud and set LUXAND_API_TOKEN.

const LUXAND_LIVENESS_URL = 'https://api.luxand.cloud/photo/liveness/v2';

export function isLivenessConfigured(): boolean {
  return Boolean(process.env.LUXAND_API_TOKEN && process.env.LUXAND_API_TOKEN.trim());
}

/**
 * Dev/testing mock for the face checks (liveness + doc-match). Active when
 * MOCK_LIVENESS=true, or automatically when Luxand is not configured and we're
 * not in production (mirrors the KYC and telephony mocks). Set MOCK_LIVENESS=false
 * to force the real provider in dev.
 */
export function isMockLiveness(): boolean {
  const flag = process.env.MOCK_LIVENESS?.trim().toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return !isLivenessConfigured() && process.env.NODE_ENV !== 'production';
}

/** True when a face check can run at all — real provider or dev mock. */
export function isLivenessAvailable(): boolean {
  return isLivenessConfigured() || isMockLiveness();
}

/**
 * Pass threshold as a 0–1 probability. Accepts LIVENESS_CONFIDENCE_THRESHOLD as
 * either a 0–1 value (e.g. 0.7) or a 0–100 percentage (e.g. 70) for convenience.
 */
export function livenessThreshold(): number {
  const raw = Number(process.env.LIVENESS_CONFIDENCE_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0) return 0.5;
  return raw > 1 ? raw / 100 : raw;
}

export interface LivenessResult {
  real: boolean;
  score: number; // 0–1 probability the face is live
  raw: unknown;
}

/**
 * Run passive liveness on a single JPEG/PNG frame.
 * Luxand returns either { status: 'success', score: <0-1> } (v2) or a
 * { result: 'real' | 'fake' } shape — we handle both.
 */
export async function checkLiveness(image: Buffer): Promise<LivenessResult> {
  if (isMockLiveness()) {
    return { real: true, score: 0.99, raw: { mock: true } };
  }
  const token = process.env.LUXAND_API_TOKEN!.trim();

  const form = new FormData();
  const blob = new Blob([new Uint8Array(image)], { type: 'image/jpeg' });
  form.append('photo', blob, 'selfie.jpg');

  let data: any;
  try {
    const resp = await axios.post(LUXAND_LIVENESS_URL, form, {
      headers: { token },
      timeout: 20000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    data = resp.data;
  } catch (err: any) {
    const detail =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      'liveness provider error';
    throw Object.assign(new Error(String(detail)), { code: 'LIVENESS_PROVIDER_ERROR' });
  }

  // Normalise the various response shapes Luxand can return.
  let score = 0;
  if (typeof data?.score === 'number') score = data.score;
  else if (typeof data?.probability === 'number') score = data.probability;
  else if (typeof data?.liveness === 'number') score = data.liveness;

  const resultStr = String(data?.result ?? data?.status ?? '').toLowerCase();
  const realByString = resultStr === 'real' || resultStr === 'live';
  // v2 success means the call worked, not that the face is live — rely on score.
  const real =
    score > 0 ? score >= livenessThreshold() : realByString;

  return { real, score: score || (real ? 1 : 0), raw: data };
}

export function faceMatchThreshold(): number {
  const raw = Number(process.env.FACE_MATCH_THRESHOLD);
  if (!Number.isFinite(raw) || raw <= 0) return 0.7;
  return raw > 1 ? raw / 100 : raw;
}

export interface FaceMatchResult {
  matched: boolean;
  score: number;
  raw: unknown;
}

const LUXAND_SIMILARITY_URL = 'https://api.luxand.cloud/photo/similarity';

/** Compare DigiLocker / KYC photo to the live selfie (Luxand similarity). */
export async function compareFaces(docPhoto: Buffer, selfie: Buffer): Promise<FaceMatchResult> {
  if (isMockLiveness()) {
    return { matched: true, score: 0.99, raw: { mock: true } };
  }
  const token = process.env.LUXAND_API_TOKEN!.trim();
  const form = new FormData();
  form.append('photo1', new Blob([new Uint8Array(docPhoto)], { type: 'image/jpeg' }), 'doc.jpg');
  form.append('photo2', new Blob([new Uint8Array(selfie)], { type: 'image/jpeg' }), 'selfie.jpg');

  let data: any;
  try {
    const resp = await axios.post(LUXAND_SIMILARITY_URL, form, {
      headers: { token },
      timeout: 25000,
      maxContentLength: Infinity,
      maxBodyLength: Infinity,
    });
    data = resp.data;
  } catch (err: any) {
    const detail =
      err?.response?.data?.error ||
      err?.response?.data?.message ||
      err?.message ||
      'face match provider error';
    throw Object.assign(new Error(String(detail)), { code: 'FACE_MATCH_PROVIDER_ERROR' });
  }

  let score = 0;
  if (typeof data?.score === 'number') score = data.score;
  else if (typeof data?.similarity === 'number') score = data.similarity;
  else if (typeof data?.probability === 'number') score = data.probability;
  if (score > 1) score = score / 100;

  return { matched: score >= faceMatchThreshold(), score, raw: data };
}
