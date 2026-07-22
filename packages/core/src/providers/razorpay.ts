/**
 * Razorpay payments (ported from backend/api razorpay.ts).
 */
import crypto from 'crypto';
import {config} from '../config';
import {logger} from '../logger';
import type {PaymentsProvider} from './types';

const JOB = 'provider:razorpay';

function creds(): {keyId: string; keySecret: string} {
  const keyId = config.RAZORPAY_KEY_ID;
  const keySecret = config.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new Error('Razorpay is not configured (RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET).');
  }
  return {keyId, keySecret};
}

function authHeader(): string {
  const {keyId, keySecret} = creds();
  return `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`;
}

export const razorpayPaymentsProvider: PaymentsProvider = {
  configured: true,

  async createOrder(input) {
    const res = await fetch('https://api.razorpay.com/v1/orders', {
      method: 'POST',
      headers: {
        Authorization: authHeader(),
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        amount: input.amountPaise,
        currency: 'INR',
        receipt: input.receipt,
        notes: input.notes ?? {},
      }),
    });
    if (!res.ok) {
      const text = await res.text();
      logger.warn(JOB, 'order create failed', {status: res.status, detail: text.slice(0, 200)});
      throw new Error('Could not create Razorpay order.');
    }
    const data = (await res.json()) as {id: string};
    logger.info(JOB, 'order created', {orderId: data.id});
    return {orderId: data.id, amountPaise: input.amountPaise};
  },

  verifyPaymentSignature(input): boolean {
    const {keySecret} = creds();
    const payload = `${input.orderId}|${input.paymentId}`;
    const expected = crypto.createHmac('sha256', keySecret).update(payload).digest('hex');
    return expected === input.signature;
  },

  verifyWebhook(rawBody, signature): boolean {
    const secret = config.RAZORPAY_WEBHOOK_SECRET;
    if (!secret) return false;
    const body = typeof rawBody === 'string' ? rawBody : rawBody.toString('utf8');
    const expected = crypto.createHmac('sha256', secret).update(body).digest('hex');
    return expected === signature;
  },
};
