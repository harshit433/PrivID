import axios from 'axios';
import { logger } from '../utils/logger';

/**
 * MSG91 OTP-widget access-token verification (server side).
 *
 * The mobile app runs the MSG91 `sendotp-react-native` widget, which sends and
 * verifies the OTP on-device and returns a short-lived **access token**. The app
 * hands that token to us; we verify it against MSG91 to confirm the phone was
 * genuinely verified (never trust the client alone), then link the number.
 *
 * https://docs.msg91.com/otp/widget → verifyAccessToken
 *
 * Config: MSG91_AUTH_KEY (server env). Absent → typed NOT_CONFIGURED error.
 */

const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';
const JOB = 'msg91';

export class Msg91Error extends Error {
  code: string;
  httpStatus: number;
  constructor(message: string, code: string, httpStatus = 502) {
    super(message);
    this.code = code;
    this.httpStatus = httpStatus;
  }
}

export interface Msg91VerifiedPhone {
  /** Normalised E.164, e.g. +919876543210 */
  phone_e164: string;
  identifier: string;
}

function toE164(identifier: string): string {
  const digits = identifier.replace(/[^\d]/g, '');
  if (!digits) throw new Msg91Error('MSG91 returned no phone number.', 'MSG91_NO_PHONE', 502);
  return `+${digits}`;
}

/** Verify the widget access-token and return the confirmed phone number. */
export async function verifyMsg91AccessToken(accessToken: string): Promise<Msg91VerifiedPhone> {
  const authkey = process.env.MSG91_AUTH_KEY;
  if (!authkey) {
    throw new Msg91Error(
      'Phone verification is not configured on the server (MSG91_AUTH_KEY missing).',
      'MSG91_NOT_CONFIGURED',
      503,
    );
  }

  const token = accessToken.trim();
  if (token.length < 10) {
    throw new Msg91Error('Invalid verification token.', 'MSG91_TOKEN_INVALID', 400);
  }

  let data: Record<string, unknown>;
  try {
    const res = await axios.post(
      VERIFY_URL,
      { authkey, 'access-token': token },
      { headers: { 'Content-Type': 'application/json' }, timeout: 15_000 },
    );
    data = res.data ?? {};
  } catch (err: unknown) {
    const ax = err as { response?: { data?: { message?: string } }; message?: string; code?: string };
    const detail = ax.response?.data?.message ?? ax.message ?? 'Phone verification failed';
    logger.warn(JOB, 'verifyAccessToken failed', { code: ax.code ?? 'http_error' });
    throw new Msg91Error(detail, 'MSG91_TOKEN_INVALID', 400);
  }

  if (String(data.type).toLowerCase() === 'error') {
    logger.warn(JOB, 'verifyAccessToken rejected', {});
    throw new Msg91Error(
      'We couldn’t verify that code. Please request a new one and try again.',
      'MSG91_TOKEN_REJECTED',
      400,
    );
  }

  // On success, `message` carries the verified identifier (the mobile number).
  const identifier = String(data.message ?? data.mobile ?? '').trim();
  const phone_e164 = toE164(identifier);
  logger.info(JOB, 'phone verified', {});
  return { phone_e164, identifier };
}

export function isMsg91Configured(): boolean {
  return Boolean(process.env.MSG91_AUTH_KEY);
}
