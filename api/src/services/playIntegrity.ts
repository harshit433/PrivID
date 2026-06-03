import axios from 'axios';
import { GoogleAuth } from 'google-auth-library';
import { logger } from '../utils/logger';

const PLAY_INTEGRITY_SCOPE = 'https://www.googleapis.com/auth/playintegrity';
const PACKAGE_NAME = process.env.ANDROID_PACKAGE_NAME ?? 'com.prividapp';

let authClient: GoogleAuth | null = null;

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

type IntegrityVerdict = {
  deviceRecognitionVerdict?: string[];
  appRecognitionVerdict?: string;
};

function passesDeviceVerdict(verdict: IntegrityVerdict | undefined): boolean {
  const device = verdict?.deviceRecognitionVerdict ?? [];
  return device.some((v) =>
    ['MEETS_DEVICE_INTEGRITY', 'MEETS_BASIC_INTEGRITY', 'MEETS_STRONG_INTEGRITY'].includes(v),
  );
}

function passesAppVerdict(verdict: IntegrityVerdict | undefined): boolean {
  const app = verdict?.appRecognitionVerdict;
  if (!app) return true;
  return app === 'PLAY_RECOGNIZED' || app === 'UNRECOGNIZED_VERSION';
}

export async function verifyAndroidIntegrityToken(token: string): Promise<boolean> {
  if (process.env.NODE_ENV !== 'production' && isDevFallbackToken(token)) {
    return true;
  }

  if (!isPlayIntegrityConfigured()) {
    logger.warn(
      'playIntegrity',
      'Credentials not configured — accepting token (set GOOGLE_PLAY_INTEGRITY_SERVICE_ACCOUNT_JSON for enforcement)',
    );
    return true;
  }

  if (isDevFallbackToken(token)) {
    return false;
  }

  try {
    const client = await getAuth().getClient();
    const accessToken = await client.getAccessToken();
    if (!accessToken.token) {
      logger.error('playIntegrity', 'Failed to obtain Google access token');
      return false;
    }

    const url = `https://playintegrity.googleapis.com/v1/${PACKAGE_NAME}:decodeIntegrityToken`;
    const { data } = await axios.post<{
      tokenPayloadExternal?: {
        deviceIntegrity?: IntegrityVerdict;
        appIntegrity?: IntegrityVerdict;
      };
    }>(
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
    const deviceOk = passesDeviceVerdict(payload?.deviceIntegrity);
    const appOk = passesAppVerdict(payload?.appIntegrity);

    if (!deviceOk || !appOk) {
      logger.warn('playIntegrity', 'Integrity verdict failed', {
        device: payload?.deviceIntegrity?.deviceRecognitionVerdict,
        app: payload?.appIntegrity?.appRecognitionVerdict,
      });
    }

    return deviceOk && appOk;
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error('playIntegrity', 'decodeIntegrityToken failed', { error: message });
    return false;
  }
}
