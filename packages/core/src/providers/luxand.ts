/**
 * Luxand passive liveness + face similarity (ported from backend/api liveness.ts).
 *
 * Requires LUXAND_API_TOKEN (or LIVENESS_API_KEY). Set MOCK_LIVENESS=true to force
 * the mock in dev; in production, missing credentials throw at provider init.
 */
import {config} from '../config';
import {logger} from '../logger';
import type {FaceMatchResult, LivenessProvider, LivenessResult} from './types';

const JOB = 'provider:liveness:luxand';
const LIVENESS_URL = 'https://api.luxand.cloud/photo/liveness/v2';
const SIMILARITY_URL = 'https://api.luxand.cloud/photo/similarity';

function token(): string {
  const t = (config.LUXAND_API_TOKEN ?? config.LIVENESS_API_KEY ?? '').trim();
  if (!t) throw new Error('Luxand liveness token is not configured.');
  return t;
}

function decodeImage(input: string): Buffer {
  const raw = input.includes(',') ? input.split(',')[1]! : input;
  return Buffer.from(raw, 'base64');
}

function livenessThreshold(): number {
  const raw = config.LIVENESS_CONFIDENCE_THRESHOLD;
  if (!Number.isFinite(raw) || raw <= 0) return 0.5;
  return raw > 1 ? raw / 100 : raw;
}

function faceMatchThreshold(): number {
  const raw = config.FACE_MATCH_THRESHOLD;
  if (!Number.isFinite(raw) || raw <= 0) return 0.7;
  return raw > 1 ? raw / 100 : raw;
}

async function postMultipart(
  url: string,
  fields: {name: string; buffer: Buffer; filename: string}[],
): Promise<unknown> {
  const form = new FormData();
  for (const f of fields) {
    form.append(
      f.name,
      new Blob([new Uint8Array(f.buffer)], {type: 'image/jpeg'}),
      f.filename,
    );
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {token: token()},
      body: form,
      signal: controller.signal,
    });
    const text = await res.text();
    let data: unknown = null;
    if (text) {
      try {
        data = JSON.parse(text);
      } catch {
        data = {message: text.slice(0, 300)};
      }
    }
    if (!res.ok) {
      const parsed = (data ?? {}) as {error?: string; message?: string};
      throw new Error(parsed.error ?? parsed.message ?? `Luxand HTTP ${res.status}`);
    }
    return data;
  } finally {
    clearTimeout(timer);
  }
}

export const luxandLivenessProvider: LivenessProvider = {
  mock: false,
  available: () => true,

  async check(selfieBase64: string): Promise<LivenessResult> {
    const image = decodeImage(selfieBase64);
    const data = (await postMultipart(LIVENESS_URL, [
      {name: 'photo', buffer: image, filename: 'selfie.jpg'},
    ])) as Record<string, unknown>;

    let score = 0;
    if (typeof data.score === 'number') score = data.score;
    else if (typeof data.probability === 'number') score = data.probability;
    else if (typeof data.liveness === 'number') score = data.liveness;

    const resultStr = String(data.result ?? data.status ?? '').toLowerCase();
    const realByString = resultStr === 'real' || resultStr === 'live';
    const pass = score > 0 ? score >= livenessThreshold() : realByString;

    logger.info(JOB, 'liveness check', {score, pass});
    return {pass, score: score || (pass ? 1 : 0)};
  },

  async compareFaces(aBase64: string, bBase64: string): Promise<FaceMatchResult> {
    const doc = decodeImage(aBase64);
    const selfie = decodeImage(bBase64);
    const data = (await postMultipart(SIMILARITY_URL, [
      {name: 'photo1', buffer: doc, filename: 'doc.jpg'},
      {name: 'photo2', buffer: selfie, filename: 'selfie.jpg'},
    ])) as Record<string, unknown>;

    let score = 0;
    if (typeof data.score === 'number') score = data.score;
    else if (typeof data.similarity === 'number') score = data.similarity;
    else if (typeof data.probability === 'number') score = data.probability;
    if (score > 1) score = score / 100;

    const threshold = faceMatchThreshold();
    const match = score >= threshold;
    logger.info(JOB, 'face match', {score, threshold, match});
    return {match, score};
  },
};
