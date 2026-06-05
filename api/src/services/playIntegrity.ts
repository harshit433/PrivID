import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger';

const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME ?? 'com.prividapp';
/** Match nonce TTL in trust router (5 min) with small clock skew buffer. */
const MAX_TOKEN_AGE_MS = 5 * 60 * 1000 + 30_000;

let authClient: GoogleAuth | null = null;

export type IntegrityFailureReason =
  | 'NOT_CONFIGURED'
  | 'DECODE_FAILED'
  | 'NONCE_MISMATCH'
  | 'PACKAGE_MISMATCH'
  | 'STALE_TOKEN'
  | 'DEVICE_FAILED'
  | 'APP_FAILED'
  | 'LICENSE_FAILED';

export type IntegrityCheckResult =
  | { ok: true }
  | { ok: false; reason: IntegrityFailureReason; details?: Record<string, unknown> };

type TokenPayloadExternal = {
  requestDetails?: {
    requestPackageName?: string;
    nonce?: string;
    timestampMillis?: string;
  };
  deviceIntegrity?: {
    deviceRecognitionVerdict?: string[];
  };
  appIntegrity?: {
    appRecognitionVerdict?: string;
    packageName?: string;
    versionCode?: string;
  };
  accountDetails?: {
    appLicensingVerdict?: string;
  };
};

function getServiceAccountJson(): string | null {
  return (
    process.env.GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON ??
    process.env.FIREBASE_SERVICE_ACCOUNT_JSON ??
    null
  );
}

export function isPlayIntegrityConfigured(): boolean {
  return Boolean(getServiceAccountJson() || process.env.GOOGLE_APPLICATION_CREDENTIALS);
}

/** Firebase / sideload APKs before Play publish — set on server only for internal testing. */
export function isPlayIntegritySideloadAllowed(): boolean {
  return process.env.PLAY_INTEGRITY_ALLOW_SIDELOAD === 'true';
}

/** Production Play Store enforcement (default true in production). */
export function isPlayIntegrityStrict(): boolean {
  if (process.env.NODE_ENV !== 'production') return false;
  if (isPlayIntegritySideloadAllowed()) return false;
  return process.env.PLAY_INTEGRITY_STRICT !== 'false';
}

function getAuth(): GoogleAuth {
  if (!authClient) {
    const json = getServiceAccountJson();
    authClient = json
      ? new GoogleAuth({
          credentials: JSON.parse(json) as Record<string, unknown>,
          scopes: [PLAY_INTEGRITY_SCOPE],
        })
      : new GoogleAuth({ scopes: [PLAY_INTEGRITY_SCOPE] });
  }
  return authClient;
}

function isDevFallbackToken(token: string): boolean {
  return token.startsWith('dev-android-') || token.startsWith('dev-fallback-');
}

/** Compare nonces as raw bytes — Google may return standard base64 while we issue base64url. */
function noncesMatch(expected: string, actual: string): boolean {
  if (expected === actual) return true;
  try {
    const decode = (value: string): Buffer => {
      const b64 = value.replace(/-/g, '+').replace(/_/g, '/');
      const pad = b64.length % 4 === 0 ? b64 : b64 + '='.repeat(4 - (b64.length % 4));
      return Buffer.from(pad, 'base64');
    };
    const a = decode(expected);
    const b = decode(actual);
    return a.length === b.length && a.equals(b);
  } catch {
    return false;
  }
}

function devicePasses(verdicts: string[] | undefined, strict: boolean): boolean {
  const device = verdicts ?? [];
  if (device.length === 0) return false;
  if (strict) {
    return device.some((v) =>
      v === 'MEETS_DEVICE_INTEGRITY' || v === 'MEETS_STRONG_INTEGRITY',
    );
  }
  return device.some((v) =>
    ['MEETS_DEVICE_INTEGRITY', 'MEETS_STRONG_INTEGRITY', 'MEETS_BASIC_INTEGRITY'].includes(v),
  );
}

function appPasses(
  appVerdict: string | undefined,
  strict: boolean,
  licenseVerdict?: string,
): boolean {
  if (!appVerdict) return !strict;
  if (strict) {
    if (appVerdict === 'PLAY_RECOGNIZED') return true;
    // Fresh Play releases can stay UNRECOGNIZED_VERSION for hours while LICENSED is already true.
    if (appVerdict === 'UNRECOGNIZED_VERSION' && licenseVerdict === 'LICENSED') return true;
    return false;
  }
  if (isPlayIntegritySideloadAllowed()) {
    return appVerdict === 'PLAY_RECOGNIZED' || appVerdict === 'UNRECOGNIZED_VERSION';
  }
  return appVerdict === 'PLAY_RECOGNIZED' || appVerdict === 'UNRECOGNIZED_VERSION';
}

function licensePasses(licenseVerdict: string | undefined, strict: boolean): boolean {
  if (!strict) {
    if (!licenseVerdict || licenseVerdict === 'UNEVALUATED') return true;
    if (isPlayIntegritySideloadAllowed()) {
      return licenseVerdict === 'LICENSED' || licenseVerdict === 'UNLICENSED' || licenseVerdict === 'UNEVALUATED';
    }
    return licenseVerdict === 'LICENSED' || licenseVerdict === 'UNLICENSED';
  }
  return licenseVerdict === 'LICENSED';
}

function validateRequestDetails(
  details: TokenPayloadExternal['requestDetails'],
  expectedNonce: string | undefined,
): IntegrityCheckResult | null {
  if (!details?.requestPackageName || details.requestPackageName !== PACKAGE_NAME) {
    return {
      ok: false,
      reason: 'PACKAGE_MISMATCH',
      details: { requestPackageName: details?.requestPackageName, expected: PACKAGE_NAME },
    };
  }

  if (expectedNonce) {
    if (!details.nonce || !noncesMatch(expectedNonce, details.nonce)) {
      return {
        ok: false,
        reason: 'NONCE_MISMATCH',
        details: {
          hasNonce: Boolean(details.nonce),
          expectedLen: expectedNonce.length,
          actualLen: details.nonce?.length ?? 0,
        },
      };
    }
  }

  if (details.timestampMillis) {
    const ts = Number(details.timestampMillis);
    if (!Number.isFinite(ts) || Date.now() - ts > MAX_TOKEN_AGE_MS) {
      return {
        ok: false,
        reason: 'STALE_TOKEN',
        details: { timestampMillis: details.timestampMillis },
      };
    }
  }

  return null;
}

export function integrityFailureMessage(reason: IntegrityFailureReason): string {
  switch (reason) {
    case 'NOT_CONFIGURED':
      return 'Device attestation is not configured on the server. Contact support.';
    case 'NONCE_MISMATCH':
      return 'Security check expired. Please retry device verification.';
    case 'PACKAGE_MISMATCH':
      return 'This install does not match the official TrustRoute app.';
    case 'STALE_TOKEN':
      return 'Security check timed out. Please retry.';
    case 'DEVICE_FAILED':
      return 'This device did not pass Google device integrity (rooted, emulator, or modified system).';
    case 'APP_FAILED':
      return isPlayIntegrityStrict()
        ? 'Install TrustRoute from Google Play. Modified or unofficial builds are not supported.'
        : 'This app build could not be verified. Use Google Play or an approved test build.';
    case 'LICENSE_FAILED':
      return 'This install is not licensed through Google Play. Install from the Play Store.';
    case 'DECODE_FAILED':
    default:
      return 'Google Play Integrity could not verify this install. Try again or install from Google Play.';
  }
}

/**
 * Decode and validate a Play Integrity token (classic nonce flow).
 * @param expectedNonce — must match the nonce issued by GET /trust/nonce (production).
 */
export async function verifyAndroidIntegrityToken(
  token: string,
  expectedNonce?: string,
): Promise<IntegrityCheckResult> {
  if (process.env.NODE_ENV !== 'production' && isDevFallbackToken(token)) {
    return { ok: true };
  }

  if (process.env.NODE_ENV === 'production' && !isPlayIntegrityConfigured()) {
    logger.error(
      'playIntegrity',
      'Production requires FIREBASE_SERVICE_ACCOUNT_JSON or GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON with Play Integrity access',
    );
    return { ok: false, reason: 'NOT_CONFIGURED' };
  }

  if (!isPlayIntegrityConfigured()) {
    logger.warn(
      'playIntegrity',
      'Credentials not configured — skipping enforcement (dev/staging only)',
    );
    return { ok: true };
  }

  if (isDevFallbackToken(token)) {
    return { ok: false, reason: 'APP_FAILED', details: { devToken: true } };
  }

  const strict = isPlayIntegrityStrict();

  try {
    const client = await getAuth().getClient();
    const accessToken = await client.getAccessToken();
    if (!accessToken.token) {
      logger.error('playIntegrity', 'Failed to obtain Google access token');
      return { ok: false, reason: 'DECODE_FAILED' };
    }

    const url = `https://playintegrity.googleapis.com/v1/${PACKAGE_NAME}:decodeIntegrityToken`;
    const { data } = await axios.post<{ tokenPayloadExternal?: TokenPayloadExternal }>(
      url,
      { integrityToken: token },
      {
        headers: {
          Authorization: `Bearer ${accessToken.token}`,
          'Content-Type': 'application/json',
        },
        timeout: 10_000,
      },
    );

    const payload = data.tokenPayloadExternal;
    if (!payload) {
      return { ok: false, reason: 'DECODE_FAILED', details: { emptyPayload: true } };
    }

    const requestError = validateRequestDetails(payload.requestDetails, expectedNonce);
    if (requestError) return requestError;

    const expectedVersion = process.env.ANDROID_EXPECTED_VERSION_CODE;
    if (
      expectedVersion &&
      payload.appIntegrity?.versionCode &&
      payload.appIntegrity.versionCode !== expectedVersion
    ) {
      return {
        ok: false,
        reason: 'APP_FAILED',
        details: {
          versionCode: payload.appIntegrity.versionCode,
          expectedVersion,
        },
      };
    }

    const deviceOk = devicePasses(payload.deviceIntegrity?.deviceRecognitionVerdict, strict);
    const licenseVerdict = payload.accountDetails?.appLicensingVerdict;
    const appOk = appPasses(payload.appIntegrity?.appRecognitionVerdict, strict, licenseVerdict);
    const licenseOk = licensePasses(licenseVerdict, strict);

    if (!deviceOk || !appOk || !licenseOk) {
      logger.warn('playIntegrity', 'Integrity verdict failed', {
        strict,
        reason: !deviceOk ? 'DEVICE_FAILED' : !appOk ? 'APP_FAILED' : 'LICENSE_FAILED',
        device: payload.deviceIntegrity?.deviceRecognitionVerdict,
        app: payload.appIntegrity?.appRecognitionVerdict,
        license: payload.accountDetails?.appLicensingVerdict,
        versionCode: payload.appIntegrity?.versionCode,
      });
      if (!deviceOk) return { ok: false, reason: 'DEVICE_FAILED' };
      if (!appOk) return { ok: false, reason: 'APP_FAILED' };
      return { ok: false, reason: 'LICENSE_FAILED' };
    }

    return { ok: true };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('playIntegrity', 'decodeIntegrityToken failed', { error: message });
    return { ok: false, reason: 'DECODE_FAILED', details: { error: message } };
  }
}
