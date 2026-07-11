import https from 'https';
import { createHash } from 'crypto';
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
 *
 * If the credentials are absent we throw a typed `DIGILOCKER_NOT_CONFIGURED`
 * error (a real, explicit "not set up" — never a fake success).
 */

const JOB = 'digilocker';

export type DigilockerStatus =
  | 'unauthenticated' // request created, user hasn't consented yet
  | 'authenticated'   // user consented; data can be fetched
  | 'expired'
  | 'revoked'
  | 'error';

export interface DigilockerRequest {
  id: string;            // Setu request id (our provider_ref)
  url: string;           // hosted DigiLocker consent URL to open in a browser/WebView
  status: DigilockerStatus;
  validUpto?: string;
}

export interface DigilockerAadhaar {
  legalName: string;
  dob?: string;
  gender?: string;
  address?: string;
  maskedNumber?: string; // e.g. XXXXXXXX1234 — DigiLocker never exposes the full number
  photoBase64?: string;  // for downstream liveness face-match / dedup
  /** Stable identity fingerprint (no raw Aadhaar): sha256(maskedNumber|name|dob). */
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
  return {
    baseUrl: (process.env.SETU_DG_BASE_URL?.trim().replace(/\/$/, '') || 'https://dg-sandbox.setu.co'),
    clientId,
    clientSecret,
    productInstanceId,
    redirectUrl,
  };
}

/** Prefer IPv4 — some hosts (incl. Setu from cloud egress) mishandle IPv6 and return opaque 403s. */
const ipv4Agent = new https.Agent({ family: 4, keepAlive: true });

async function setuRequest<T>(
  cfg: DgConfig,
  method: 'GET' | 'POST',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const url = new URL(path, `${cfg.baseUrl}/`);
  const payload = body ? JSON.stringify(body) : undefined;

  const res = await new Promise<{ status: number; text: string }>((resolve, reject) => {
    const req = https.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || 443,
        path: `${url.pathname}${url.search}`,
        method,
        agent: ipv4Agent,
        timeout: 20_000,
        headers: {
          Accept: 'application/json',
          'Content-Type': 'application/json',
          'x-client-id': cfg.clientId,
          'x-client-secret': cfg.clientSecret,
          'x-product-instance-id': cfg.productInstanceId,
          ...(payload ? { 'Content-Length': Buffer.byteLength(payload) } : {}),
        },
      },
      (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (c) => chunks.push(Buffer.isBuffer(c) ? c : Buffer.from(c)));
        incoming.on('end', () => {
          resolve({
            status: incoming.statusCode ?? 0,
            text: Buffer.concat(chunks).toString('utf8'),
          });
        });
      },
    );
    req.on('timeout', () => {
      req.destroy();
      reject(Object.assign(new Error('DigiLocker request timed out'), { code: 'ECONNABORTED' }));
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });

  let data: unknown = null;
  if (res.text) {
    try {
      data = JSON.parse(res.text);
    } catch {
      data = { message: res.text.slice(0, 300) };
    }
  }

  if (res.status < 200 || res.status >= 300) {
    const parsed = (data ?? {}) as {
      error?: { detail?: string; code?: string; message?: string };
      message?: string;
      traceId?: string;
    };
    const detail =
      parsed.error?.detail ??
      parsed.error?.message ??
      parsed.message ??
      `DigiLocker HTTP ${res.status}`;
    const code = parsed.error?.code ?? 'DIGILOCKER_HTTP_ERROR';
    logger.warn(JOB, 'DigiLocker call failed', {
      status: res.status,
      code,
      detail: String(detail).slice(0, 200),
      body: res.text.slice(0, 300),
      traceId: parsed.traceId,
      clientIdPrefix: cfg.clientId.slice(0, 8),
      host: url.hostname,
    });
    throw new DigilockerError(String(detail), code, res.status >= 500 || res.status === 0 ? 502 : res.status);
  }

  return data as T;
}

/** Create a DigiLocker request → returns the hosted consent URL + our provider ref. */
export async function createDigilockerRequest(): Promise<DigilockerRequest> {
  const cfg = getConfig();
  try {
    // Match Setu Bridge docs: only redirectUrl is required.
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
    const e = err as { code?: string; message?: string };
    if (e.code === 'ECONNABORTED') {
      throw new DigilockerError('DigiLocker request timed out', 'DIGILOCKER_TIMEOUT', 504);
    }
    logger.warn(JOB, 'DigiLocker call failed', { status: 0, code: e.code, detail: e.message });
    throw new DigilockerError(e.message ?? 'DigiLocker request failed', 'DIGILOCKER_CREATE_FAILED', 502);
  }
}

/** Poll the request status; `authenticated` means the user consented on DigiLocker. */
export async function getDigilockerStatus(id: string): Promise<DigilockerStatus> {
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

/** Fetch the government-verified Aadhaar profile once the request is authenticated. */
export async function fetchAadhaar(id: string): Promise<DigilockerAadhaar> {
  const cfg = getConfig();
  try {
    const data = await setuRequest<{ aadhaar?: Record<string, unknown> } & Record<string, unknown>>(
      cfg,
      'GET',
      `/api/digilocker/${encodeURIComponent(id)}/aadhaar`,
    );
    // Setu wraps the KYC payload under `aadhaar` (fields per Setu DigiLocker docs).
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
