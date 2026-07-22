/**
 * Real DigiLocker KYC via Setu (https://docs.setu.co/data/digilocker).
 *
 * Setu is a licensed DigiLocker aggregator: we create a DigiLocker "request", hand
 * the user Setu's hosted consent URL, and — once they've authenticated on
 * DigiLocker — pull their government-verified Aadhaar (legal name, DOB, photo).
 * Nothing is mocked here.
 *
 * Geo note: Setu returns nginx 403 from non-India IPs, and Railway runs in
 * Singapore — so when SETU_DG_PROXY_BASE_URL is set we route calls through an
 * India (Mumbai) egress proxy, forwarding the shared x-proxy-secret. Ported from
 * the pre-rewrite backend's api/src/services/digilocker.ts (curl → native fetch).
 *
 * Required env: SETU_DG_CLIENT_ID, SETU_DG_CLIENT_SECRET, SETU_DG_PRODUCT_INSTANCE_ID,
 * SETU_DG_REDIRECT_URL. Optional: SETU_DG_BASE_URL (default sandbox),
 * SETU_DG_PROXY_BASE_URL + SETU_DG_PROXY_SECRET.
 */
import {config} from '../config';
import {logger} from '../logger';
import type {KycProvider, KycStatus} from './types';

const JOB = 'provider:kyc:setu';

interface DgConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  productInstanceId: string;
  redirectUrl: string;
  proxySecret?: string;
}

function dgConfig(fallbackRedirect: string): DgConfig {
  const clientId = config.SETU_DG_CLIENT_ID?.trim();
  const clientSecret = config.SETU_DG_CLIENT_SECRET?.trim();
  const productInstanceId = config.SETU_DG_PRODUCT_INSTANCE_ID?.trim();
  const redirectUrl = config.SETU_DG_REDIRECT_URL?.trim() || fallbackRedirect;
  if (!clientId || !clientSecret || !productInstanceId) {
    throw new Error('DigiLocker (Setu) is not configured.');
  }
  // Prefer the India proxy when set — Railway (SG) is geo-fenced by Setu.
  const proxyBase = config.SETU_DG_PROXY_BASE_URL?.trim().replace(/\/$/, '');
  const directBase =
    config.SETU_DG_BASE_URL?.trim().replace(/\/$/, '') ||
    'https://dg-sandbox.setu.co';
  return {
    baseUrl: proxyBase || directBase,
    clientId,
    clientSecret,
    productInstanceId,
    redirectUrl,
    proxySecret: config.SETU_DG_PROXY_SECRET?.trim() || undefined,
  };
}

async function setuRequest<T>(
  cfg: DgConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const headers: Record<string, string> = {
    Accept: 'application/json',
    'Content-Type': 'application/json',
    'x-client-id': cfg.clientId,
    'x-client-secret': cfg.clientSecret,
    'x-product-instance-id': cfg.productInstanceId,
  };
  if (cfg.proxySecret) {
    headers['x-proxy-secret'] = cfg.proxySecret;
  }
  // ngrok free tier returns an HTML interstitial unless this header is set.
  if (/ngrok(-free)?\.app/i.test(cfg.baseUrl)) {
    headers['ngrok-skip-browser-warning'] = '1';
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 25_000);
  let res: Response;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
  } catch (err) {
    logger.warn(JOB, 'DigiLocker request failed', {
      detail: String((err as Error)?.message ?? err).slice(0, 200),
      host: cfg.baseUrl,
    });
    throw new Error('DigiLocker request failed.');
  } finally {
    clearTimeout(timer);
  }

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
    const parsed = (data ?? {}) as {
      error?: {detail?: string; code?: string; message?: string};
      message?: string;
    };
    const detail =
      parsed.error?.detail ??
      parsed.error?.message ??
      parsed.message ??
      `DigiLocker HTTP ${res.status}`;
    logger.warn(JOB, 'DigiLocker call failed', {
      status: res.status,
      detail: String(detail).slice(0, 200),
      host: cfg.baseUrl,
      clientIdPrefix: cfg.clientId.slice(0, 8),
    });
    if (res.status === 403 || /403|forbidden|geo|blocked/i.test(String(detail))) {
      throw new Error(
        'DigiLocker is unavailable from this server region. Configure SETU_DG_PROXY_BASE_URL.',
      );
    }
    throw new Error(String(detail));
  }
  return data as T;
}

/** Setu status → our KycStatus. */
function mapStatus(setuStatus: string | undefined): KycStatus['status'] {
  switch ((setuStatus ?? '').toLowerCase()) {
    case 'authenticated':
      return 'verified';
    case 'unauthenticated':
      return 'pending';
    case 'expired':
      return 'expired';
    default:
      return 'failed';
  }
}

export const setuKycProvider: KycProvider = {
  mock: false,

  async createRequest(redirectUrl) {
    const cfg = dgConfig(redirectUrl);
    const data = await setuRequest<{id: string; url: string; status?: string}>(
      cfg,
      'POST',
      '/api/digilocker',
      {redirectUrl: cfg.redirectUrl},
    );
    if (!data?.id || !data?.url) {
      throw new Error('Unexpected DigiLocker response.');
    }
    logger.info(JOB, 'DigiLocker request created', {requestId: data.id});
    return {requestId: data.id, authUrl: data.url};
  },

  async getStatus(requestId) {
    const cfg = dgConfig('');
    const data = await setuRequest<{status?: string}>(
      cfg,
      'GET',
      `/api/digilocker/${encodeURIComponent(requestId)}/status`,
    );
    return {status: mapStatus(data?.status), providerRef: requestId};
  },

  async fetchIdentity(requestId) {
    const cfg = dgConfig('');
    const data = await setuRequest<
      {aadhaar?: Record<string, unknown>} & Record<string, unknown>
    >(cfg, 'GET', `/api/digilocker/${encodeURIComponent(requestId)}/aadhaar`);
    const a = (data.aadhaar ?? data) as Record<string, unknown>;
    const legalName = String(a.name ?? a.fullName ?? '').trim();
    if (!legalName) {
      throw new Error('DigiLocker did not return a verified name.');
    }
    const maskedAadhaar = a.maskedNumber ? String(a.maskedNumber) : 'XXXXXXXXXXXX';
    logger.info(JOB, 'Aadhaar fetched', {requestId});
    return {
      legalName,
      maskedAadhaar,
      dob: a.dob ? String(a.dob) : undefined,
      photoBase64: a.photo ? String(a.photo) : undefined,
    };
  },
};
