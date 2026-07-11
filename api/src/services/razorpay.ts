import crypto from 'crypto';
import { AppError } from '../middleware/errorHandler';
import {
  createPaymentOrderRecord,
  creditTopUp,
  markPaymentOrderPaid,
  activatePrivacyPack,
} from './wallet';

export interface RazorpayOrderResponse {
  order_id: string;
  razorpay_order_id: string;
  amount_paise: number;
  currency: string;
  key_id: string;
}

export const PRIVACY_PACK_PRICE_PAISE = 14900;
export const PRIVACY_PACK_ORDER_ID = 'privacy_pack_sub';

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

async function createRazorpayOrder(params: {
  amountPaise: number;
  receipt: string;
  notes: Record<string, string>;
}): Promise<string> {
  const { keyId, keySecret } = getRazorpayCreds();
  const auth = Buffer.from(`${keyId}:${keySecret}`).toString('base64');
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      Authorization: `Basic ${auth}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      amount: params.amountPaise,
      currency: 'INR',
      receipt: params.receipt,
      notes: params.notes,
    }),
  });
  if (!res.ok) {
    throw new AppError(502, 'PAYMENT_ORDER_FAILED', 'Could not start payment.');
  }
  const data = await res.json() as { id: string };
  return data.id;
}

export async function createTopUpOrder(userId: string, packId: string): Promise<RazorpayOrderResponse> {
  const { keyId } = getRazorpayCreds();
  const { getWalletPacks } = await import('./wallet');
  const pack = getWalletPacks().find((p) => p.id === packId);
  if (!pack) throw new AppError(400, 'INVALID_PACK', 'Unknown top-up pack.');

  const razorpayOrderId = await createRazorpayOrder({
    amountPaise: pack.amount_paise,
    receipt: `topup_${userId.slice(0, 8)}_${Date.now()}`,
    notes: { user_id: userId, pack_id: packId },
  });
  const record = await createPaymentOrderRecord(userId, packId, razorpayOrderId);

  return {
    order_id: record.order_id,
    razorpay_order_id: razorpayOrderId,
    amount_paise: record.amount_paise,
    currency: 'INR',
    key_id: keyId,
  };
}

/** One-time Razorpay order that activates Privacy Pack after payment.captured. */
export async function createPrivacyPackOrder(userId: string): Promise<RazorpayOrderResponse> {
  const { keyId } = getRazorpayCreds();
  const razorpayOrderId = await createRazorpayOrder({
    amountPaise: PRIVACY_PACK_PRICE_PAISE,
    receipt: `priv_${userId.slice(0, 8)}_${Date.now()}`,
    notes: { user_id: userId, pack_id: PRIVACY_PACK_ORDER_ID },
  });
  const record = await createPaymentOrderRecord(
    userId,
    PRIVACY_PACK_ORDER_ID,
    razorpayOrderId,
    PRIVACY_PACK_PRICE_PAISE,
  );
  return {
    order_id: record.order_id,
    razorpay_order_id: razorpayOrderId,
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

  if (paid.pack_id === PRIVACY_PACK_ORDER_ID) {
    await activatePrivacyPack(paid.user_id, orderId);
    return;
  }

  const ref = `rzp:${orderId}`;
  await creditTopUp(paid.user_id, paid.amount_paise, ref, paid.pack_id);
}
