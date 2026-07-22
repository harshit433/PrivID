/**
 * RazorpayX payouts + fund accounts (ported from backend/api razorpayx.ts).
 */
import crypto from 'crypto';
import {config} from '../config';
import {logger} from '../logger';
import type {PayoutsProvider} from './types';

const JOB = 'provider:razorpayx';

function creds(): {keyId: string; keySecret: string; accountNumber: string} | null {
  const keyId = config.RAZORPAY_KEY_ID;
  const keySecret = config.RAZORPAY_KEY_SECRET;
  const accountNumber = config.RAZORPAYX_ACCOUNT_NUMBER;
  if (!keyId || !keySecret || !accountNumber) return null;
  return {keyId, keySecret, accountNumber};
}

function requireCreds(): {keyId: string; keySecret: string; accountNumber: string} {
  const c = creds();
  if (!c) {
    throw new Error(
      'RazorpayX is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET / RAZORPAYX_ACCOUNT_NUMBER).',
    );
  }
  return c;
}

function authHeader(): string {
  const {keyId, keySecret} = requireCreds();
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

async function post(path: string, body: unknown): Promise<Record<string, unknown>> {
  const res = await fetch(`https://api.razorpay.com/v1${path}`, {
    method: 'POST',
    headers: {
      Authorization: authHeader(),
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const text = await res.text();
    logger.warn(JOB, 'API call failed', {path, status: res.status, detail: text.slice(0, 200)});
    throw new Error('Payout gateway error.');
  }
  return res.json() as Promise<Record<string, unknown>>;
}

export async function createRazorpayContact(
  userId: string,
  name: string,
  email?: string,
): Promise<string> {
  const data = await post('/contacts', {
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
  const data = await post('/fund_accounts', {
    contact_id: params.contactId,
    account_type: 'vpa',
    vpa: {address: params.upiId},
  });
  return String(data.id);
}

export async function createFundAccountBank(params: {
  contactId: string;
  name: string;
  ifsc: string;
  accountNumber: string;
}): Promise<string> {
  const data = await post('/fund_accounts', {
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

export function verifyRazorpayXWebhookSignature(rawBody: Buffer | string, signature: string): boolean {
  const secret = config.RAZORPAYX_WEBHOOK_SECRET ?? config.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
  const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
  return expected === signature;
}

export const razorpayxPayoutsProvider: PayoutsProvider = {
  configured: Boolean(creds()),

  async createPayout(input) {
    if (!input.fundAccountRef) {
      throw new Error('fundAccountRef is required for RazorpayX payouts.');
    }
    const {accountNumber} = requireCreds();
    const data = await post('/payouts', {
      account_number: accountNumber,
      fund_account_id: input.fundAccountRef,
      amount: input.amountPaise,
      currency: 'INR',
      mode: 'UPI',
      purpose: 'payout',
      queue_if_low_balance: true,
      reference_id: input.idempotencyKey,
    });
    const payoutRef = String(data.id ?? '');
    const statusRaw = String(data.status ?? 'processing').toLowerCase();
    const status =
      statusRaw === 'processed' || statusRaw === 'completed'
        ? 'paid'
        : statusRaw === 'failed' || statusRaw === 'reversed'
        ? 'failed'
        : 'processing';
    logger.info(JOB, 'payout created', {payoutRef, status});
    return {payoutRef, status};
  },
};
