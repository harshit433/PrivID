import axios from 'axios';
import { logger } from '../utils/logger';

const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';
const FLOW_URL = 'https://control.msg91.com/api/v5/flow/';

function isJwtLike(token: string): boolean {
  const parts = token.trim().split('.');
  return parts.length === 3 && parts.every((part) => part.length >= 10);
}

export interface Msg91VerifiedUser {
  phone_e164: string;
  identifier: string;
  raw: Record<string, unknown>;
}

/**
 * Validates the JWT access-token returned by MSG91 OTPWidget.verifyOTP on the client.
 * https://docs.msg91.com/otp-widget/verify-access-token
 */
export async function verifyMsg91AccessToken(accessToken: string): Promise<Msg91VerifiedUser> {
  const authkey = process.env.MSG91_AUTH_KEY;
  if (!authkey) {
    throw Object.assign(new Error('MSG91_AUTH_KEY is not configured on the server'), {
      code: 'MSG91_NOT_CONFIGURED',
    });
  }

  const token = accessToken.trim();
  if (!isJwtLike(token)) {
    throw Object.assign(
      new Error(
        'Invalid MSG91 access token. Enable Server-Side Integration on your MSG91 OTP widget and link your account Authkey (must match MSG91_AUTH_KEY).'
      ),
      { code: 'MSG91_TOKEN_INVALID' }
    );
  }

  let data: Record<string, unknown>;
  try {
    const res = await axios.post(
      VERIFY_URL,
      { authkey, 'access-token': token },
      {
        headers: { 'Content-Type': 'application/json' },
        timeout: 15_000,
      }
    );
    data = res.data ?? {};
  } catch (err: unknown) {
    const ax = err as { response?: { data?: { message?: string } }; message?: string };
    let msg = ax.response?.data?.message ?? ax.message ?? 'MSG91 token verification failed';
    if (msg.includes('access-token field is required')) {
      msg =
        'Invalid MSG91 access token. Enable Server-Side Integration on your OTP widget and set the same Authkey as MSG91_AUTH_KEY.';
    }
    throw Object.assign(new Error(msg), { code: 'MSG91_TOKEN_INVALID' });
  }

  const type = data.type as string | undefined;
  const status = data.status as string | undefined;
  if (type === 'error' || status === 'error') {
    let msg = (data.message as string) ?? 'MSG91 access token is invalid';
    if (msg.includes('access-token field is required')) {
      msg =
        'Invalid MSG91 access token. Enable Server-Side Integration on your OTP widget and set the same Authkey as MSG91_AUTH_KEY.';
    }
    throw Object.assign(new Error(msg), { code: 'MSG91_TOKEN_INVALID' });
  }

  const identifier = extractIdentifier(data);
  if (!identifier) {
    throw Object.assign(new Error('MSG91 did not return a verified phone identifier'), {
      code: 'MSG91_TOKEN_INVALID',
    });
  }

  const digits = identifier.replace(/\D/g, '');
  return {
    identifier: digits,
    phone_e164: `+${digits}`,
    raw: data,
  };
}

function extractIdentifier(data: Record<string, unknown>): string | null {
  const candidates = [
    data.identifier,
    data.mobile,
    data.phone,
    (data.data as Record<string, unknown> | undefined)?.identifier,
    (data.data as Record<string, unknown> | undefined)?.mobile,
    (data.message as string | undefined)?.match(/^\d{10,15}$/)?.[0],
  ];

  for (const c of candidates) {
    if (typeof c === 'string' && c.replace(/\D/g, '').length >= 10) {
      return c.replace(/\D/g, '');
    }
  }
  return null;
}

/** Build SMS body for Android SMS Retriever (must end with 11-char app hash). */
export function buildSimVerificationSmsBody(code: string, appHash: string): string {
  return `<#> PrivID SIM: ${code}\n${appHash}`;
}

/**
 * Send SIM binding challenge SMS via MSG91.
 * Uses MSG91_SIM_SMS_TEMPLATE_ID when set; otherwise sends a raw transactional SMS.
 */
export async function sendSimVerificationSms(
  phoneE164: string,
  code: string,
  appHash: string,
): Promise<void> {
  const authkey = process.env.MSG91_AUTH_KEY;
  const message = buildSimVerificationSmsBody(code, appHash);
  const mobile = phoneE164.replace(/\s/g, '').replace(/^\+/, '');

  if (!authkey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.info('msg91', `[dev] SIM SMS to ${phoneE164}: ${message}`);
      return;
    }
    throw Object.assign(new Error('MSG91_AUTH_KEY is not configured on the server'), {
      code: 'MSG91_NOT_CONFIGURED',
    });
  }

  const templateId = process.env.MSG91_SIM_SMS_TEMPLATE_ID ?? process.env.MSG91_TEMPLATE_ID;
  const sender = process.env.MSG91_SMS_SENDER ?? 'PRIVID';

  try {
    if (templateId) {
      await axios.post(
        FLOW_URL,
        {
          template_id: templateId,
          short_url: '0',
          recipients: [
            {
              mobiles: mobile,
              code,
              hash: appHash,
              var: code,
              VAR1: code,
              VAR2: appHash,
            },
          ],
        },
        {
          headers: { authkey, 'Content-Type': 'application/json' },
          timeout: 15_000,
        },
      );
      return;
    }

    await axios.post(
      'https://control.msg91.com/api/v5/sms/',
      {
        sender,
        route: '4',
        country: '91',
        sms: [{ message, to: [mobile] }],
      },
      {
        headers: { authkey, 'Content-Type': 'application/json' },
        timeout: 15_000,
      },
    );
  } catch (err: unknown) {
    const ax = err as { response?: { data?: { message?: string } }; message?: string };
    const msg = ax.response?.data?.message ?? ax.message ?? 'Failed to send SIM verification SMS';
    logger.error('msg91', 'SIM SMS send failed', msg);
    throw Object.assign(new Error(msg), { code: 'SIM_SMS_SEND_FAILED' });
  }
}
