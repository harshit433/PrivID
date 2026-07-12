import { execFile } from 'child_process';
import { createHash, randomUUID } from 'crypto';
import { promisify } from 'util';
import { logger } from '../utils/logger';

/**
 * Real DigiLocker KYC via Setu (https://docs.setu.co/data/digilocker).
 *
 * Setu is a licensed DigiLocker aggregator: we create a DigiLocker "request",
 * hand the user Setu's hosted consent URL, and — once the user has authenticated
 * on DigiLocker — pull their government-verified Aadhaar data (legal name, DOB,
 * gender, address, photo). No document is ever mocked.
 *
 * Configuration (server env — required to go live; get these from your Setu
 * dashboard, sandbox works out of the box):
 *   SETU_DG_BASE_URL             default https://dg-sandbox.setu.co  (prod: https://dg.setu.co)
 *   SETU_DG_CLIENT_ID            x-client-id
 *   SETU_DG_CLIENT_SECRET        x-client-secret
 *   SETU_DG_PRODUCT_INSTANCE_ID  x-product-instance-id
 *   SETU_DG_REDIRECT_URL         public HTTPS return URL after DigiLocker consent
 *                                (prod: https://www.trustroute.live/digilocker/)
 *   SETU_DG_PROXY_BASE_URL       optional India egress proxy (Railway is SG; Setu
 *                                is India-IP-only). Example: https://xxx.fly.dev
 *   SETU_DG_PROXY_SECRET         shared secret sent as x-proxy-secret when proxying
 *
 * Transport note: Setu returns nginx 403 from non-India IPs. We call via `curl`,
 * optionally through SETU_DG_PROXY_BASE_URL hosted in Mumbai (bom).
 *
 * If the credentials are absent we throw a typed `DIGILOCKER_NOT_CONFIGURED`
 * error (a real, explicit "not set up" — never a fake success).
 */

const JOB = 'digilocker';
const execFileAsync = promisify(execFile);

export type DigilockerStatus =
  | 'unauthenticated'
  | 'authenticated'
  | 'expired'
  | 'revoked'
  | 'error';

export interface DigilockerRequest {
  id: string;
  url: string;
  status: DigilockerStatus;
  validUpto?: string;
}

export interface DigilockerAadhaar {
  legalName: string;
  dob?: string;
  gender?: string;
  address?: string;
  maskedNumber?: string;
  photoBase64?: string;
  docHash: string;
}

export class DigilockerError extends Error {
  code: string;
  httpStatus: number;
  constructor(message: string, code: string, httpStatus = 502) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

interface DgConfig {
  baseUrl: string;
  clientId: string;
  clientSecret: string;
  productInstanceId: string;
  redirectUrl: string;
  proxySecret?: string;
}

function getConfig(): DgConfig {
  const clientId = process.env.SETU_DG_CLIENT_ID?.trim();
  const clientSecret = process.env.SETU_DG_CLIENT_SECRET?.trim();
  const productInstanceId = process.env.SETU_DG_PRODUCT_INSTANCE_ID?.trim();
  const redirectUrl = process.env.SETU_DG_REDIRECT_URL?.trim();

  if (!clientId || !clientSecret || !productInstanceId || !redirectUrl) {
    throw new DigilockerError(
      'DigiLocker (Setu) is not configured on the server. Set SETU_DG_CLIENT_ID, ' +
        'SETU_DG_CLIENT_SECRET, SETU_DG_PRODUCT_INSTANCE_ID and SETU_DG_REDIRECT_URL.',
      'DIGILOCKER_NOT_CONFIGURED',
      503,
    );
  }
  // Prefer India proxy when set — Railway southeast-asia is blocked by Setu geo fence.
  const proxyBase = process.env.SETU_DG_PROXY_BASE_URL?.trim().replace(/\/$/, '');
  const directBase = process.env.SETU_DG_BASE_URL?.trim().replace(/\/$/, '') || 'https://dg-sandbox.setu.co';
  return {
    baseUrl: proxyBase || directBase,
    clientId,
    clientSecret,
    productInstanceId,
    redirectUrl,
    proxySecret: process.env.SETU_DG_PROXY_SECRET?.trim() || undefined,
  };
}

/**
 * Dev/testing mock. Active when MOCK_KYC=true, or automatically when Setu is
 * not configured and we're not in production (mirrors the telephony mock). Lets
 * the whole onboarding/KYC flow run end-to-end with no real Setu/DigiLocker.
 * Set MOCK_KYC=false to force the real client even in dev.
 */
export function isMockKyc(): boolean {
  const flag = process.env.MOCK_KYC?.trim().toLowerCase();
  if (flag === 'true' || flag === '1') return true;
  if (flag === 'false' || flag === '0') return false;
  return !isDigilockerConfigured() && process.env.NODE_ENV !== 'production';
}

/**
 * The URL the mobile WebView opens for "consent". We point it straight at the
 * existing success callback so the app's redirect detection fires immediately
 * and no separate hosted page is needed. Falls back to the app deep-link if no
 * public API base is known.
 */
function mockAuthUrl(id: string): string {
  const base = (process.env.API_BASE_URL || '').replace(/\/+$/, '');
  if (base) return `${base}/digilocker/callback?success=true&id=${encodeURIComponent(id)}`;
  return `trustroute://digilocker/done?success=true&id=${encodeURIComponent(id)}`;
}

/**
 * Deterministic mock Aadhaar. By default each new request yields a fresh
 * identity (unique docHash) so you can spin up many test accounts. Set
 * MOCK_KYC_AADHAAR to a fixed seed to always resolve to one stable identity
 * (useful for testing dedup / "already have an account"); MOCK_KYC_NAME overrides
 * the legal name.
 */
function mockAadhaar(id: string): DigilockerAadhaar {
  const seed = process.env.MOCK_KYC_AADHAAR?.trim() || id;
  const h = createHash('sha256').update(`mock-kyc|${seed}`).digest('hex');
  const legalName = process.env.MOCK_KYC_NAME?.trim() || `Test User ${h.slice(0, 4).toUpperCase()}`;
  const last4 = (parseInt(h.slice(0, 6), 16) % 10000).toString().padStart(4, '0');
  return {
    legalName,
    dob: '1995-01-01',
    gender: 'M',
    address: 'Mock Address, Bengaluru, Karnataka, India',
    maskedNumber: `XXXXXXXX${last4}`,
    photoBase64: undefined,
    docHash: h,
  };
}

async function setuRequest<T>(
  cfg: DgConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = `${cfg.baseUrl}${path.startsWith('/') ? path : `/${path}`}`;
  const args = [
    '-sS',
    '-o',
    '-',
    '-w',
    '\n__HTTP_CODE__:%{http_code}',
    '--max-time',
    '20',
    '-X',
    method,
    url,
    '-H',
    'Accept: application/json',
    '-H',
    'Content-Type: application/json',
    '-H',
    `x-client-id: ${cfg.clientId}`,
    '-H',
    `x-client-secret: ${cfg.clientSecret}`,
    '-H',
    `x-product-instance-id: ${cfg.productInstanceId}`,
  ];
  if (cfg.proxySecret) {
    args.push('-H', `x-proxy-secret: ${cfg.proxySecret}`);
  }
  if (body) {
    args.push('-d', JSON.stringify(body));
  }

  let stdout = '';
  try {
    const result = await execFileAsync('curl', args, { timeout: 25_000, maxBuffer: 2_000_000 });
    stdout = String(result.stdout || '');
  } catch (err) {
    const e = err as { code?: string; message?: string; stdout?: string; stderr?: string };
    stdout = String(e.stdout || '');
    if (!stdout) {
      logger.warn(JOB, 'DigiLocker curl failed', {
        status: 0,
        code: e.code,
        detail: (e.stderr || e.message || '').slice(0, 200),
        clientIdPrefix: cfg.clientId.slice(0, 8),
      });
      throw new DigilockerError(
        e.message || 'DigiLocker request failed',
        e.code === 'ETIMEDOUT' ? 'DIGILOCKER_TIMEOUT' : 'DIGILOCKER_ERROR',
        e.code === 'ETIMEDOUT' ? 504 : 502,
      );
    }
  }

  const marker = '\n__HTTP_CODE__:';
  const idx = stdout.lastIndexOf(marker);
  const text = idx >= 0 ? stdout.slice(0, idx) : stdout;
  const status = idx >= 0 ? Number(stdout.slice(idx + marker.length).trim()) : 0;

  let data: unknown = null;
  if (text) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text.slice(0, 300) };
    }
  }

  if (status < 200 || status >= 300) {
    const parsed = (data ?? {}) as {
      error?: { detail?: string; code?: string; message?: string };
      message?: string;
      traceId?: string;
    };
    const detail =
      parsed.error?.detail ??
      parsed.error?.message ??
      parsed.message ??
      `DigiLocker HTTP ${status}`;
    const code = parsed.error?.code ?? 'DIGILOCKER_HTTP_ERROR';
    logger.warn(JOB, 'DigiLocker call failed', {
      status,
      code,
      detail: String(detail).slice(0, 200),
      body: text.slice(0, 300),
      traceId: parsed.traceId,
      clientIdPrefix: cfg.clientId.slice(0, 8),
      host: cfg.baseUrl,
    });
    throw new DigilockerError(String(detail), code, status >= 500 || status === 0 ? 502 : status);
  }

  return data as T;
}

export async function createDigilockerRequest(): Promise<DigilockerRequest> {
  if (isMockKyc()) {
    const id = `mockdg_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
    logger.warn(JOB, 'DigiLocker MOCK request created (dev — no real Setu)', { requestId: id });
    return { id, url: mockAuthUrl(id), status: 'unauthenticated' };
  }
  const cfg = getConfig();
  try {
    const data = await setuRequest<{ id: string; url: string; status: string; validUpto?: string }>(
      cfg,
      'POST',
      '/api/digilocker',
      { redirectUrl: cfg.redirectUrl },
    );
    if (!data?.id || !data?.url) {
      throw new DigilockerError('Unexpected DigiLocker response.', 'DIGILOCKER_BAD_RESPONSE');
    }
    logger.info(JOB, 'DigiLocker request created', { requestId: data.id, status: data.status });
    return {
      id: data.id,
      url: data.url,
      status: (data.status as DigilockerStatus) ?? 'unauthenticated',
      validUpto: data.validUpto,
    };
  } catch (err) {
    if (err instanceof DigilockerError) throw err;
    throw new DigilockerError('DigiLocker create failed', 'DIGILOCKER_CREATE_FAILED', 502);
  }
}

export async function getDigilockerStatus(id: string): Promise<DigilockerStatus> {
  if (isMockKyc()) return 'authenticated';
  const cfg = getConfig();
  try {
    const data = await setuRequest<{ status?: string }>(
      cfg,
      'GET',
      `/api/digilocker/${encodeURIComponent(id)}/status`,
    );
    return (data?.status as DigilockerStatus) ?? 'error';
  } catch (err) {
    if (err instanceof DigilockerError) throw err;
    throw new DigilockerError('DigiLocker status check failed', 'DIGILOCKER_STATUS_FAILED', 502);
  }
}

export async function fetchAadhaar(id: string): Promise<DigilockerAadhaar> {
  if (isMockKyc()) {
    const a = mockAadhaar(id);
    logger.warn(JOB, 'DigiLocker MOCK Aadhaar returned (dev — no real Setu)', { requestId: id, legalName: a.legalName });
    return a;
  }
  const cfg = getConfig();
  try {
    const data = await setuRequest<{ aadhaar?: Record<string, unknown> } & Record<string, unknown>>(
      cfg,
      'GET',
      `/api/digilocker/${encodeURIComponent(id)}/aadhaar`,
    );
    const a = data.aadhaar ?? data;
    const legalName = String(a.name ?? a.fullName ?? '').trim();
    if (!legalName) {
      throw new DigilockerError('DigiLocker did not return a verified name.', 'DIGILOCKER_NO_NAME');
    }
    const maskedNumber = a.maskedNumber ? String(a.maskedNumber) : undefined;
    const dob = a.dob ? String(a.dob) : undefined;
    const docHash = createHash('sha256')
      .update(`${maskedNumber ?? ''}|${legalName.toLowerCase()}|${dob ?? ''}`)
      .digest('hex');

    logger.info(JOB, 'Aadhaar fetched', { requestId: id });
    return {
      legalName,
      dob,
      gender: a.gender ? String(a.gender) : undefined,
      address: a.address ? String(a.address) : undefined,
      maskedNumber,
      photoBase64: a.photo ? String(a.photo) : undefined,
      docHash,
    };
  } catch (err) {
    if (err instanceof DigilockerError) throw err;
    throw new DigilockerError('DigiLocker fetch failed', 'DIGILOCKER_FETCH_FAILED', 502);
  }
}

export function isDigilockerConfigured(): boolean {
  return Boolean(
    process.env.SETU_DG_CLIENT_ID?.trim() &&
      process.env.SETU_DG_CLIENT_SECRET?.trim() &&
      process.env.SETU_DG_PRODUCT_INSTANCE_ID?.trim() &&
      process.env.SETU_DG_REDIRECT_URL?.trim(),
  );
}
