import axios from 'axios';
import { logger } from '../utils/logger';

const VERIFY_URL = 'https://control.msg91.com/api/v5/widget/verifyAccessToken';
const FLOW_URL = 'https://control.msg91.com/api/v5/flow/';
const OTP_URL = 'https://control.msg91.com/api/v5/otp';

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

type Msg91ResponseBody = {
  type?: string;
  status?: string;
  message?: string;
  request_id?: string;
};

function parseMsg91Error(err: unknown): string {
  const ax = err as {
    response?: { data?: Msg91ResponseBody | string };
    message?: string;
  };
  const data = ax.response?.data;
  if (typeof data === 'string' && data.trim()) return data;
  if (data && typeof data === 'object' && data.message) return data.message;
  return ax.message ?? 'Failed to send SIM verification SMS';
}

function assertMsg91Success(data: unknown, context: string): void {
  if (!data || typeof data !== 'object') return;
  const body = data as Msg91ResponseBody;
  if (body.type === 'error' || body.status === 'error') {
    throw new Error(body.message ?? `${context} rejected by MSG91`);
  }
}

/** Flow / OneAPI template — must be a SMS Flow ID from MSG91 Templates (not the OTP widget template). */
async function sendSimSmsViaFlow(
  authkey: string,
  flowId: string,
  mobile: string,
  code: string,
  appHash: string,
): Promise<void> {
  const sender = process.env.MSG91_SMS_SENDER;
  const codeVar = process.env.MSG91_SIM_SMS_VAR_CODE ?? 'VAR1';
  const hashVar = process.env.MSG91_SIM_SMS_VAR_HASH ?? 'VAR2';

  const recipient: Record<string, string> = { mobiles: mobile, [codeVar]: code, [hashVar]: appHash };

  const payload: Record<string, unknown> = {
    flow_id: flowId,
    template_id: flowId,
    short_url: '0',
    recipients: [recipient],
  };
  if (sender) payload.sender = sender;

  const res = await axios.post(FLOW_URL, payload, {
    headers: { authkey, 'Content-Type': 'application/json' },
    timeout: 15_000,
  });

  assertMsg91Success(res.data, 'Flow API');
}

/** OTP API — uses the same DLT OTP template as login (delivers SMS; user may enter code manually). */
async function sendSimSmsViaOtp(
  authkey: string,
  templateId: string,
  mobile: string,
  code: string,
): Promise<void> {
  const res = await axios.post(
    OTP_URL,
    {
      authkey,
      template_id: templateId,
      mobile,
      otp: code,
      otp_length: 6,
      otp_expiry: 2,
    },
    {
      headers: { authkey, 'Content-Type': 'application/json' },
      timeout: 15_000,
    },
  );

  assertMsg91Success(res.data, 'OTP API');
}

function codedError(message: string, code: string): Error {
  return Object.assign(new Error(message), { code });
}

/**
 * Send SIM binding challenge SMS via MSG91.
 *
 * Priority:
 * 1. MSG91_SIM_SMS_FLOW_ID — Flow template with code + app-hash vars (enables Android auto-read)
 * 2. MSG91_OTP_TEMPLATE_ID — same OTP template as login (SMS delivered; manual code entry OK)
 */
export async function sendSimVerificationSms(
  phoneE164: string,
  code: string,
  appHash: string,
): Promise<void> {
  const authkey = process.env.MSG91_AUTH_KEY;
  const mobile = phoneE164.replace(/\s/g, '').replace(/^\+/, '');

  if (!authkey) {
    if (process.env.NODE_ENV !== 'production') {
      logger.debug('msg91', `[dev] SIM SMS to ${phoneE164}: ${buildSimVerificationSmsBody(code, appHash)}`);
      return;
    }
    throw codedError('MSG91_AUTH_KEY is not configured on the server', 'MSG91_NOT_CONFIGURED');
  }

  const flowId = process.env.MSG91_SIM_SMS_FLOW_ID ?? process.env.MSG91_SIM_SMS_TEMPLATE_ID;
  const otpTemplateId = process.env.MSG91_OTP_TEMPLATE_ID ?? process.env.MSG91_TEMPLATE_ID;

  try {
    if (flowId) {
      await sendSimSmsViaFlow(authkey, flowId, mobile, code, appHash);
      logger.info('msg91', `SIM SMS sent via Flow ${flowId} → ${phoneE164}`);
      return;
    }

    if (otpTemplateId) {
      await sendSimSmsViaOtp(authkey, otpTemplateId, mobile, code);
      logger.info('msg91', `SIM SMS sent via OTP template ${otpTemplateId} → ${phoneE164}`);
      return;
    }

    throw codedError(
      'SIM SMS is not configured. Set MSG91_OTP_TEMPLATE_ID (same as login OTP) or MSG91_SIM_SMS_FLOW_ID on Railway.',
      'MSG91_SIM_SMS_NOT_CONFIGURED',
    );
  } catch (err: unknown) {
    const existing = err as { code?: string; message?: string };
    if (existing.code && existing.code !== 'SIM_SMS_SEND_FAILED') {
      throw err;
    }

    const msg = parseMsg91Error(err);
    logger.error('msg91', 'SIM SMS send failed:', msg);
    throw codedError(msg, 'SIM_SMS_SEND_FAILED');
  }
}
