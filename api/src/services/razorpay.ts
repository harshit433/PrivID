import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import {
  createPaymentOrderRecord,
  creditTopUp,
  markPaymentOrderPaid,
} from './wallet';

export interface RazorpayOrderResponse {
  order_id: string;
  razorpay_order_id: string;
  amount_paise: number;
  currency: string;
  key_id: string;
}

function getRazorpayCreds(): { keyId: string; keySecret: string } {
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret) {
    throw new AppError(503, 'PAYMENTS_UNAVAILABLE', 'Payments are briefly unavailable.');
  }
  return { keyId, keySecret };
}

export function isRazorpayConfigured(): boolean {
  return Boolean(process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET);
}

export async function createTopUpOrder(userId: string, packId: string): Promise<RazorpayOrderResponse> {
  const { keyId, keySecret } = getRazorpayCreds();

  const { getWalletPacks } = await import('./wallet');
  const pack = getWalletPacks().find((p) => p.id === packId);
  if (!pack) throw new AppError(400, 'INVALID_PACK', 'Unknown top-up pack.');

  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: pack.amount_paise,
      currency: 'INR',
      receipt: `topup_${userId.slice(0, 8)}_${Date.now()}`,
      notes: { user_id: userId, pack_id: packId },
    }),
  });

  if (!res.ok) {
    throw new AppError(502, 'PAYMENT_ORDER_FAILED', 'Could not start payment.');
  }

  const data = await res.json() as { id: string };
  const record = await createPaymentOrderRecord(userId, packId, data.id);

  return {
    order_id: record.order_id,
    razorpay_order_id: data.id,
    amount_paise: record.amount_paise,
    currency: 'INR',
    key_id: keyId,
  };
}

export function verifyRazorpayWebhookSignature(rawBody: Buffer, signature: string): boolean {
  const secret = process.env.RAZORPAY_WEBHOOK_SECRET;
  if (!secret) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  return expected === signature;
}

export async function handleRazorpayWebhook(payload: {
  event: string;
  payload: { payment?: { entity?: { order_id?: string; status?: string } } };
}): Promise<void> {
  if (payload.event !== 'payment.captured') return;
  const orderId = payload.payload?.payment?.entity?.order_id;
  if (!orderId) return;

  const paid = await markPaymentOrderPaid(orderId);
  if (!paid) return; // already processed or unknown order

  const ref = `rzp:${orderId}`;
  await creditTopUp(paid.user_id, paid.amount_paise, ref, paid.pack_id);
}
