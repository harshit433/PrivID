import axios, { type AxiosInstance } from 'axios';
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
  const clientId = process.env.SETU_DG_CLIENT_ID;
  const clientSecret = process.env.SETU_DG_CLIENT_SECRET;
  const productInstanceId = process.env.SETU_DG_PRODUCT_INSTANCE_ID;
  const redirectUrl = process.env.SETU_DG_REDIRECT_URL;

  if (!clientId || !clientSecret || !productInstanceId || !redirectUrl) {
    throw new DigilockerError(
      'DigiLocker (Setu) is not configured on the server. Set SETU_DG_CLIENT_ID, ' +
        'SETU_DG_CLIENT_SECRET, SETU_DG_PRODUCT_INSTANCE_ID and SETU_DG_REDIRECT_URL.',
      'DIGILOCKER_NOT_CONFIGURED',
      503,
    );
  }
  return {
    baseUrl: process.env.SETU_DG_BASE_URL?.replace(/\/$/, '') ?? 'https://dg-sandbox.setu.co',
    clientId,
    clientSecret,
    productInstanceId,
    redirectUrl,
  };
}

function client(cfg: DgConfig): AxiosInstance {
  return axios.create({
    baseURL: cfg.baseUrl,
    timeout: 20_000,
    headers: {
      'Content-Type': 'application/json',
      'x-client-id': cfg.clientId,
      'x-client-secret': cfg.clientSecret,
      'x-product-instance-id': cfg.productInstanceId,
    },
  });
}

function toDigilockerError(err: unknown, fallbackCode = 'DIGILOCKER_ERROR'): DigilockerError {
  if (err instanceof DigilockerError) return err;
  const ax = err as { response?: { status?: number; data?: { error?: { detail?: string; code?: string } } }; message?: string; code?: string };
  const status = ax.response?.status ?? 502;
  const detail = ax.response?.data?.error?.detail ?? ax.message ?? 'DigiLocker request failed';
  const code = ax.response?.data?.error?.code ?? (ax.code === 'ECONNABORTED' ? 'DIGILOCKER_TIMEOUT' : fallbackCode);
  // PII-safe: never log names/documents — only provider status/code.
  logger.warn(JOB, 'DigiLocker call failed', { status, code });
  return new DigilockerError(detail, code, status >= 500 || status === 0 ? 502 : status);
}

/** Create a DigiLocker request → returns the hosted consent URL + our provider ref. */
export async function createDigilockerRequest(): Promise<DigilockerRequest> {
  const cfg = getConfig();
  try {
    const { data } = await client(cfg).post('/api/digilocker', {
      redirectUrl: cfg.redirectUrl,
      docType: 'AADHAAR',
    });
    const req = data as { id: string; url: string; status: string; validUpto?: string };
    if (!req?.id || !req?.url) {
      throw new DigilockerError('Unexpected DigiLocker response.', 'DIGILOCKER_BAD_RESPONSE');
    }
    logger.info(JOB, 'DigiLocker request created', { requestId: req.id, status: req.status });
    return { id: req.id, url: req.url, status: (req.status as DigilockerStatus) ?? 'unauthenticated', validUpto: req.validUpto };
  } catch (err) {
    throw toDigilockerError(err, 'DIGILOCKER_CREATE_FAILED');
  }
}

/** Poll the request status; `authenticated` means the user consented on DigiLocker. */
export async function getDigilockerStatus(id: string): Promise<DigilockerStatus> {
  const cfg = getConfig();
  try {
    const { data } = await client(cfg).get(`/api/digilocker/${encodeURIComponent(id)}/status`);
    return ((data as { status?: string })?.status as DigilockerStatus) ?? 'error';
  } catch (err) {
    throw toDigilockerError(err, 'DIGILOCKER_STATUS_FAILED');
  }
}

/** Fetch the government-verified Aadhaar profile once the request is authenticated. */
export async function fetchAadhaar(id: string): Promise<DigilockerAadhaar> {
  const cfg = getConfig();
  try {
    const { data } = await client(cfg).get(`/api/digilocker/${encodeURIComponent(id)}/aadhaar`);
    // Setu wraps the KYC payload under `aadhaar` (fields per Setu DigiLocker docs).
    const a = (data as { aadhaar?: Record<string, unknown> }).aadhaar ?? (data as Record<string, unknown>);
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
    throw toDigilockerError(err, 'DIGILOCKER_FETCH_FAILED');
  }
}

export function isDigilockerConfigured(): boolean {
  return Boolean(
    process.env.SETU_DG_CLIENT_ID &&
      process.env.SETU_DG_CLIENT_SECRET &&
      process.env.SETU_DG_PRODUCT_INSTANCE_ID &&
      process.env.SETU_DG_REDIRECT_URL,
  );
}
