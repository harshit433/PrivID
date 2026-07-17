/**
 * Wallet service: balance, ledger, top-up (Razorpay order → verify → credit), and the
 * hold/settle primitives masked-calling uses. Crediting is idempotent on the Razorpay
 * order id so a webhook + client verify can both fire without double-crediting.
 */
import {
  appError,
  getPaymentsProvider,
  buildPage,
  decodeCursor,
  logger,
  type PageMeta,
} from '@trustroute/core';
import * as repo from './wallet.repository';
import type { WalletTxnRow } from './wallet.repository';

/** Top-up packs (paise + bonus talk-minutes). Single source of truth. */
export const PACKS: Record<string, { amountPaise: number; minutes: number; label: string }> = {
  pack_99: { amountPaise: 9900, minutes: 100, label: '₹99' },
  pack_199: { amountPaise: 19900, minutes: 220, label: '₹199' },
  pack_499: { amountPaise: 49900, minutes: 600, label: '₹499' },
};

function txnView(t: WalletTxnRow) {
  return {
    txnId: t.txnId,
    type: t.type,
    amountPaise: t.amountPaise,
    minutes: t.minutes,
    balanceAfter: t.balanceAfter,
    ref: t.ref,
    createdAt: t.createdAt,
  };
}

export async function getBalance(userId: string) {
  const w = await repo.ensureWallet(userId);
  return {
    balancePaise: w.balancePaise,
    autoRechargeEnabled: w.autoRechargeEnabled,
    autoRechargePackId: w.autoRechargePackId,
    autoRechargeThresholdPaise: w.autoRechargeThresholdPaise,
  };
}

export async function transactions(
  userId: string,
  limit: number,
  cursor?: string,
): Promise<{ items: ReturnType<typeof txnView>[]; meta: PageMeta }> {
  const rows = await repo.listTransactions(userId, limit, decodeCursor(cursor));
  const page = buildPage(rows, limit, (r) => ({ t: r.createdAt.toISOString(), id: r.txnId }));
  return { items: page.items.map(txnView), meta: page.meta };
}

/** Create a Razorpay order for a pack. The client pays, then calls verify. */
export async function createTopupOrder(userId: string, packId: string) {
  const pack = PACKS[packId];
  if (!pack) throw appError('BAD_REQUEST', 'Unknown pack.');
  await repo.ensureWallet(userId);
  const payments = getPaymentsProvider();
  const order = await payments.createOrder({ amountPaise: pack.amountPaise, receipt: `topup_${userId}_${Date.now()}`, notes: { userId, packId } });
  await repo.createOrder({ userId, razorpayOrderId: order.orderId, amountPaise: pack.amountPaise, packId });
  return {
    orderId: order.orderId,
    amountPaise: pack.amountPaise,
    packId,
    minutes: pack.minutes,
    provider: payments.configured ? 'razorpay' : 'mock',
  };
}

/**
 * Verify a completed payment and credit the wallet. The credit is keyed on the order
 * id (`topup:<orderId>`) so re-verifying — or a racing webhook — is a no-op.
 */
export async function verifyTopup(userId: string, input: { orderId: string; paymentId: string; signature: string }) {
  const payments = getPaymentsProvider();
  if (!payments.verifyPaymentSignature(input)) throw appError('PAYMENT_FAILED', 'Payment signature verification failed.');

  const order = await repo.findOrderByRazorpayId(input.orderId);
  if (!order || order.userId !== userId) throw appError('NOT_FOUND', 'Order not found.');

  await repo.markOrderPaid(order.orderId);
  const pack = PACKS[order.packId];
  const { balanceAfter } = await repo.applyTxn(userId, {
    type: 'topup',
    amountPaise: order.amountPaise,
    minutes: pack?.minutes ?? null,
    ref: `topup:${order.razorpayOrderId}`,
    meta: { packId: order.packId, paymentId: input.paymentId },
  });
  return { creditedPaise: order.amountPaise, balancePaise: balanceAfter };
}

/** Razorpay webhook — credits on `payment.captured` (idempotent, same ref as verify). */
export async function handleWebhook(rawBody: Buffer | string, signature: string, payload: unknown) {
  const payments = getPaymentsProvider();
  if (!payments.verifyWebhook(rawBody, signature)) throw appError('FORBIDDEN', 'Invalid webhook signature.');
  const event = payload as { event?: string; payload?: { payment?: { entity?: { order_id?: string; id?: string } } } };
  const entity = event.payload?.payment?.entity;
  if (event.event !== 'payment.captured' || !entity?.order_id) return { handled: false };

  const order = await repo.findOrderByRazorpayId(entity.order_id);
  if (!order) return { handled: false };
  await repo.markOrderPaid(order.orderId);
  const pack = PACKS[order.packId];
  await repo.applyTxn(order.userId, {
    type: 'topup',
    amountPaise: order.amountPaise,
    minutes: pack?.minutes ?? null,
    ref: `topup:${order.razorpayOrderId}`,
    meta: { via: 'webhook', paymentId: entity.id },
  });
  logger.info('wallet', 'wallet credited via webhook', { orderId: order.orderId });
  return { handled: true };
}

export async function setAutoRecharge(userId: string, input: { enabled: boolean; packId?: string; thresholdPaise?: number }) {
  if (input.enabled && input.packId && !PACKS[input.packId]) throw appError('BAD_REQUEST', 'Unknown pack.');
  await repo.ensureWallet(userId);
  const w = await repo.setAutoRecharge(userId, input);
  return { autoRechargeEnabled: w.autoRechargeEnabled, autoRechargePackId: w.autoRechargePackId, autoRechargeThresholdPaise: w.autoRechargeThresholdPaise };
}

export async function subscription(userId: string) {
  const s = await repo.getSubscription(userId);
  return { subscription: s ? { plan: s.plan, status: s.status, minutesIncluded: s.minutesIncluded, renewsAt: s.renewsAt } : null };
}

// ── Primitives for masked-calling (P4 deferred → wired here) ─────────────────

/** Reserve funds for a call. Throws INSUFFICIENT_BALANCE if the balance can't cover it. */
export async function hold(userId: string, amountPaise: number, ref: string) {
  await repo.ensureWallet(userId);
  return repo.applyTxn(userId, { type: 'hold', amountPaise: -Math.abs(amountPaise), ref, meta: { kind: 'masked_call_hold' } });
}

/** Settle a prior hold: refund the unused remainder (hold − actualCost). */
export async function settleHold(userId: string, heldPaise: number, actualCostPaise: number, ref: string) {
  const refund = Math.max(0, heldPaise - actualCostPaise);
  if (refund === 0) return;
  await repo.applyTxn(userId, { type: 'release', amountPaise: refund, ref, meta: { kind: 'masked_call_release', actualCostPaise } });
}
