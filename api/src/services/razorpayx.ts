import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import { isRazorpayXEnabled } from './referralConfig';

function getRazorpayXCreds(): { keyId: string; keySecret: string; accountNumber: string } | null {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const accountNumber = process.env.RAZORPAYX_ACCOUNT_NUMBER;
  if (!keyId || !keySecret || !accountNumber) return null;
  return { keyId, keySecret, accountNumber };
}

export function isRazorpayXConfigured(): boolean {
  return getRazorpayXCreds() !== null;
}

function authHeader(): string {
  const creds = getRazorpayXCreds();
  if (!creds) throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
  return `Basic ${Buffer.from(`${creds.keyId}:${creds.keySecret}`).toString('base64')}`;
}

async function razorpayXFetch(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    throw new AppError(502, 'PAYOUT_GATEWAY_ERROR', 'Withdrawals are briefly unavailable — try again soon.');
  }
  return res.json() as Promise<Record<string, unknown>>;
}

export async function createRazorpayContact(userId: string, name: string, email?: string): Promise<string> {
  if (!isRazorpayXConfigured()) {
    if (process.env.NODE_ENV === 'production' && process.env.RAZORPAYX_MOCK !== 'true') {
      throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
    }
    return `mock_contact_${userId.slice(0, 8)}`;
  }
  const data = await razorpayXFetch('/contacts', {
    name,
    email: email ?? `${userId.slice(0, 8)}@trustroute.app`,
    type: 'customer',
    reference_id: userId,
  });
  return String(data.id);
}

export async function createFundAccountUpi(params: {
  contactId: string;
  upiId: string;
}): Promise<string> {
  if (!isRazorpayXConfigured()) {
    if (process.env.NODE_ENV === 'production' && process.env.RAZORPAYX_MOCK !== 'true') {
      throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
    }
    return `mock_fa_${crypto.randomBytes(6).toString('hex')}`;
  }
  const data = await razorpayXFetch('/fund_accounts', {
    contact_id: params.contactId,
    account_type: 'vpa',
    vpa: { address: params.upiId },
  });
  return String(data.id);
}

export async function createFundAccountBank(params: {
  contactId: string;
  name: string;
  ifsc: string;
  accountNumber: string;
}): Promise<string> {
  if (!isRazorpayXConfigured()) {
    if (process.env.NODE_ENV === 'production' && process.env.RAZORPAYX_MOCK !== 'true') {
      throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
    }
    return `mock_fa_${crypto.randomBytes(6).toString('hex')}`;
  }
  const data = await razorpayXFetch('/fund_accounts', {
    contact_id: params.contactId,
    account_type: 'bank_account',
    bank_account: {
      name: params.name,
      ifsc: params.ifsc,
      account_number: params.accountNumber,
    },
  });
  return String(data.id);
}

export async function createPayout(params: {
  fundAccountId: string;
  amountPaise: number;
  referenceId: string;
}): Promise<string> {
  if (!isRazorpayXConfigured()) {
    if (process.env.NODE_ENV === 'production' && process.env.RAZORPAYX_MOCK !== 'true') {
      throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
    }
    return `mock_payout_${crypto.randomBytes(6).toString('hex')}`;
  }
  const creds = getRazorpayXCreds()!;
  const data = await razorpayXFetch('/payouts', {
    account_number: creds.accountNumber,
    fund_account_id: params.fundAccountId,
    amount: params.amountPaise,
    currency: 'INR',
    mode: 'UPI',
    purpose: 'payout',
    queue_if_low_balance: true,
    reference_id: params.referenceId,
  });
  return String(data.id);
}

export function verifyRazorpayXWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.RAZORPAYX_WEBHOOK_SECRET ?? process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return expected === signature;
}

export async function handleRazorpayXWebhook(payload: {
  event: string;
  payload?: { payout?: { entity?: { id?: string; status?: string; failure_reason?: string } } };
}): Promise<void> {
  const entity = payload.payload?.payout?.entity;
  if (!entity?.id) return;

  const { query, queryOne, withTransaction } = await import('@trustroute/shared');
  const payout = await queryOne<{ payout_id: string; user_id: string; amount_paise: number; status: string }>(
    `SELECT payout_id, user_id, amount_paise, status FROM payouts WHERE razorpayx_ref = $1`,
    [entity.id],
  );
  if (!payout) return;

  const status = entity.status;
  if (status === 'processed' || status === 'completed') {
    await query(
      `UPDATE payouts SET status = 'paid', updated_at = NOW() WHERE payout_id = $1`,
      [payout.payout_id],
    );
    return;
  }

  if (status === 'failed' || status === 'reversed') {
    await withTransaction(async (client) => {
      await client.query(
        `UPDATE payouts SET status = 'failed', failure_reason = $2, updated_at = NOW()
         WHERE payout_id = $1 AND status <> 'paid'`,
        [payout.payout_id, entity.failure_reason ?? 'Payout failed'],
      );
      await client.query(
        `UPDATE referral_wallets SET withdrawable_paise = withdrawable_paise + $2, updated_at = NOW()
         WHERE user_id = $1`,
        [payout.user_id, payout.amount_paise],
      );
      await client.query(
        `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, reference_id, description)
         VALUES ($1, $2, 'reversal', $3, $4)`,
        [payout.user_id, payout.amount_paise, payout.payout_id, 'Payout failed — balance restored'],
      );
    });
  }
}

export async function payoutsAvailable(): Promise<boolean> {
  const enabled = await isRazorpayXEnabled();
  if (!enabled) return false;
  return isRazorpayXConfigured() || process.env.RAZORPAYX_MOCK === 'true';
}
