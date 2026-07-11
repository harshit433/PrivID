import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import {
  DEFAULT_PACKS,
  estimateCostPaise,
  getPerMinuteRatePaise,
  paiseToMinutes,
  type TopUpPack,
} from './appConfig';

export type WalletTxnType =
  | 'topup' | 'hold' | 'debit' | 'release' | 'refund' | 'referral_credit' | 'adjustment';

export interface WalletSummary {
  balance_paise: number;
  minutes: number;
  per_minute_rate_paise: number;
  tier_daily_free_left: number;
  subscription: {
    plan: string;
    status: string;
    minutes_included: number;
    renews_at: string | null;
  } | null;
  auto_recharge_enabled: boolean;
  auto_recharge_pack_id: string | null;
  auto_recharge_threshold_paise: number | null;
}

export interface WalletTransaction {
  txn_id: string;
  type: WalletTxnType;
  amount_paise: number;
  minutes: number | null;
  ref: string | null;
  status: string;
  balance_after: number | null;
  meta: Record<string, unknown>;
  created_at: string;
}

async function ensureWallet(userId: string): Promise<void> {
  await query(
    `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

export async function getWalletBalancePaise(userId: string): Promise<number> {
  await ensureWallet(userId);
  const row = await queryOne<{ balance_paise: string }>(
    `SELECT balance_paise::text FROM wallets WHERE user_id = $1`,
    [userId],
  );
  return parseInt(row?.balance_paise ?? '0', 10);
}

async function getDailyFreeLeft(userId: string): Promise<number> {
  const { getMaskedDailyFreeCalls } = await import('./appConfig');
  const dailyFree = await getMaskedDailyFreeCalls();
  const row = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM masked_calls
     WHERE caller_id = $1
       AND created_at > date_trunc('day', NOW() AT TIME ZONE 'Asia/Kolkata')
       AND status NOT IN ('failed', 'cancelled')`,
    [userId],
  );
  const used = parseInt(row?.cnt ?? '0', 10);
  return Math.max(0, dailyFree - used);
}

export async function getWalletSummary(userId: string): Promise<WalletSummary> {
  await ensureWallet(userId);
  const rate = await getPerMinuteRatePaise();
  const [wallet, sub, dailyLeft] = await Promise.all([
    queryOne<{
      balance_paise: string;
      auto_recharge_enabled: boolean;
      auto_recharge_pack_id: string | null;
      auto_recharge_threshold_paise: string | null;
    }>(`SELECT balance_paise::text, auto_recharge_enabled, auto_recharge_pack_id,
               auto_recharge_threshold_paise::text
        FROM wallets WHERE user_id = $1`, [userId]),
    queryOne<{
      plan: string;
      status: string;
      minutes_included: number;
      renews_at: Date | null;
    }>(`SELECT plan, status, minutes_included, renews_at FROM privacy_subscriptions WHERE user_id = $1`, [userId]),
    getDailyFreeLeft(userId),
  ]);

  const balance = parseInt(wallet?.balance_paise ?? '0', 10);

  return {
    balance_paise: balance,
    minutes: paiseToMinutes(balance, rate),
    per_minute_rate_paise: rate,
    tier_daily_free_left: dailyLeft,
    subscription: sub && sub.status !== 'none'
      ? {
          plan: sub.plan,
          status: sub.status,
          minutes_included: sub.minutes_included,
          renews_at: sub.renews_at ? new Date(sub.renews_at).toISOString() : null,
        }
      : null,
    auto_recharge_enabled: wallet?.auto_recharge_enabled ?? false,
    auto_recharge_pack_id: wallet?.auto_recharge_pack_id ?? null,
    auto_recharge_threshold_paise: wallet?.auto_recharge_threshold_paise
      ? parseInt(wallet.auto_recharge_threshold_paise, 10)
      : null,
  };
}

export async function listWalletTransactions(
  userId: string,
  limit = 40,
  offset = 0,
  filter?: string,
): Promise<{ items: WalletTransaction[]; total: number }> {
  const params: unknown[] = [userId];
  let where = 'user_id = $1';
  if (filter && filter !== 'all') {
    const typeMap: Record<string, WalletTxnType[]> = {
      topups: ['topup'],
      calls: ['debit', 'hold', 'release'],
      referral: ['referral_credit'],
    };
    const types = typeMap[filter];
    if (types) {
      params.push(types);
      where += ` AND type = ANY($${params.length}::wallet_txn_type[])`;
    }
  }
  params.push(limit, offset);
  const limIdx = params.length - 1;
  const offIdx = params.length;

  const [items, countRow] = await Promise.all([
    query<WalletTransaction>(
      `SELECT txn_id, type, amount_paise, minutes, ref, status, balance_after, meta, created_at
       FROM wallet_transactions WHERE ${where}
       ORDER BY created_at DESC LIMIT $${limIdx} OFFSET $${offIdx}`,
      params,
    ),
    queryOne<{ total: string }>(
      `SELECT COUNT(*)::text AS total FROM wallet_transactions WHERE ${where}`,
      params.slice(0, -2),
    ),
  ]);

  return {
    items: items.map((t) => ({
      ...t,
      amount_paise: Number(t.amount_paise),
      balance_after: t.balance_after != null ? Number(t.balance_after) : null,
      created_at: new Date(t.created_at as unknown as string).toISOString(),
    })),
    total: parseInt(countRow?.total ?? '0', 10),
  };
}

export function getWalletPacks(): TopUpPack[] {
  return DEFAULT_PACKS;
}

export async function getWalletTransaction(
  userId: string,
  txnId: string,
): Promise<WalletTransaction> {
  const row = await queryOne<WalletTransaction>(
    `SELECT txn_id, type, amount_paise, minutes, ref, status, balance_after, meta, created_at
     FROM wallet_transactions WHERE txn_id = $1 AND user_id = $2`,
    [txnId, userId],
  );
  if (!row) throw new AppError(404, 'NOT_FOUND', 'Transaction not found.');
  return {
    ...row,
    amount_paise: Number(row.amount_paise),
    balance_after: row.balance_after != null ? Number(row.balance_after) : null,
    created_at: new Date(row.created_at as unknown as string).toISOString(),
  };
}

export type AutoRechargeSettings = {
  enabled: boolean;
  pack_id: string | null;
  threshold_paise: number | null;
  packs: TopUpPack[];
};

export async function getAutoRechargeSettings(userId: string): Promise<AutoRechargeSettings> {
  await ensureWallet(userId);
  const row = await queryOne<{
    auto_recharge_enabled: boolean;
    auto_recharge_pack_id: string | null;
    auto_recharge_threshold_paise: string | null;
  }>(
    `SELECT auto_recharge_enabled, auto_recharge_pack_id, auto_recharge_threshold_paise::text
     FROM wallets WHERE user_id = $1`,
    [userId],
  );
  return {
    enabled: row?.auto_recharge_enabled ?? false,
    pack_id: row?.auto_recharge_pack_id ?? null,
    threshold_paise: row?.auto_recharge_threshold_paise
      ? parseInt(row.auto_recharge_threshold_paise, 10)
      : null,
    packs: DEFAULT_PACKS,
  };
}

export async function updateAutoRecharge(
  userId: string,
  params: { enabled: boolean; pack_id?: string; threshold_paise?: number },
): Promise<AutoRechargeSettings> {
  await ensureWallet(userId);
  if (params.enabled) {
    if (!params.pack_id) throw new AppError(400, 'PACK_REQUIRED', 'Select a top-up pack.');
    packById(params.pack_id);
    const threshold = params.threshold_paise ?? 5000;
    if (threshold < 1000) {
      throw new AppError(400, 'THRESHOLD_TOO_LOW', 'Threshold must be at least ₹10.');
    }
    await query(
      `UPDATE wallets
       SET auto_recharge_enabled = TRUE,
           auto_recharge_pack_id = $2,
           auto_recharge_threshold_paise = $3,
           updated_at = NOW()
       WHERE user_id = $1`,
      [userId, params.pack_id, threshold],
    );
  } else {
    await query(
      `UPDATE wallets SET auto_recharge_enabled = FALSE, updated_at = NOW() WHERE user_id = $1`,
      [userId],
    );
  }
  return getAutoRechargeSettings(userId);
}

/** Trigger auto-recharge order when balance drops below threshold (best-effort). */
export async function maybeTriggerAutoRecharge(userId: string): Promise<{ triggered: boolean }> {
  const row = await queryOne<{
    balance_paise: string;
    auto_recharge_enabled: boolean;
    auto_recharge_pack_id: string | null;
    auto_recharge_threshold_paise: string | null;
  }>(
    `SELECT balance_paise::text, auto_recharge_enabled, auto_recharge_pack_id,
            auto_recharge_threshold_paise::text
     FROM wallets WHERE user_id = $1`,
    [userId],
  );
  if (!row?.auto_recharge_enabled || !row.auto_recharge_pack_id) return { triggered: false };
  const balance = parseInt(row.balance_paise ?? '0', 10);
  const threshold = parseInt(row.auto_recharge_threshold_paise ?? '0', 10);
  if (balance > threshold) return { triggered: false };

  const recent = await queryOne<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM payment_orders
     WHERE user_id = $1 AND status = 'created' AND created_at > NOW() - INTERVAL '30 minutes'`,
    [userId],
  );
  if (parseInt(recent?.cnt ?? '0', 10) > 0) return { triggered: false };

  try {
    const { createTopUpOrder } = await import('./razorpay');
    await createTopUpOrder(userId, row.auto_recharge_pack_id);
    return { triggered: true };
  } catch {
    return { triggered: false };
  }
}

function packById(packId: string): TopUpPack {
  const pack = DEFAULT_PACKS.find((p) => p.id === packId);
  if (!pack) throw new AppError(400, 'INVALID_PACK', 'Unknown top-up pack.');
  return pack;
}

/** Append ledger entry and update cached balance atomically. */
async function applyTxn(
  userId: string,
  type: WalletTxnType,
  amountPaise: number,
  opts: {
    ref?: string;
    minutes?: number;
    status?: string;
    meta?: Record<string, unknown>;
    /** positive = credit, negative = debit */
    balanceDelta: number;
  },
): Promise<string> {
  return withTransaction(async (client) => {
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );

    if (opts.ref) {
      const dup = await client.query(
        `SELECT txn_id FROM wallet_transactions WHERE ref = $1`,
        [opts.ref],
      );
      if (dup.rows.length > 0) return dup.rows[0].txn_id as string;
    }

    const lock = await client.query(
      `SELECT balance_paise FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const current = parseInt(lock.rows[0]?.balance_paise ?? '0', 10);
    const next = current + opts.balanceDelta;
    if (next < 0) {
      throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Insufficient wallet balance.');
    }

    const txnId = crypto.randomUUID();
    await client.query(
      `INSERT INTO wallet_transactions
         (txn_id, user_id, type, amount_paise, minutes, ref, status, balance_after, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)`,
      [
        txnId,
        userId,
        type,
        amountPaise,
        opts.minutes ?? null,
        opts.ref ?? null,
        opts.status ?? 'completed',
        next,
        JSON.stringify(opts.meta ?? {}),
      ],
    );
    await client.query(
      `UPDATE wallets SET balance_paise = $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, next],
    );
    return txnId;
  });
}

export async function creditTopUp(
  userId: string,
  amountPaise: number,
  ref: string,
  packId: string,
): Promise<void> {
  const pack = packById(packId);
  await applyTxn(userId, 'topup', amountPaise, {
    ref,
    minutes: pack.minutes,
    balanceDelta: amountPaise,
    meta: { pack_id: packId },
  });
}

export async function placeHold(
  userId: string,
  amountPaise: number,
  ref: string,
): Promise<void> {
  await applyTxn(userId, 'hold', amountPaise, {
    ref,
    balanceDelta: -amountPaise,
    meta: { masked_call_id: ref },
  });
}

export async function releaseHold(
  userId: string,
  amountPaise: number,
  ref: string,
): Promise<void> {
  await applyTxn(userId, 'release', amountPaise, {
    ref: `${ref}:release`,
    balanceDelta: amountPaise,
    meta: { masked_call_id: ref },
  });
}

export async function debitCall(
  userId: string,
  amountPaise: number,
  ref: string,
  billedSeconds: number,
): Promise<void> {
  await applyTxn(userId, 'debit', amountPaise, {
    ref: `${ref}:debit`,
    minutes: Math.ceil(billedSeconds / 60),
    balanceDelta: 0, // already held; settlement handled separately
    meta: { masked_call_id: ref, billed_seconds: billedSeconds },
  });
}

/** Settle a masked call: release unused hold, debit any overage beyond hold. */
export async function settleMaskedCall(
  userId: string,
  callId: string,
  holdPaise: number,
  actualCostPaise: number,
  billedSeconds: number,
): Promise<void> {
  await withTransaction(async (client) => {
    const holdRef = `${callId}:hold`;
    const releaseRef = `${callId}:release`;
    const debitRef = `${callId}:debit`;

    const existing = await client.query(
      `SELECT ref FROM wallet_transactions WHERE ref IN ($1, $2, $3)`,
      [holdRef, releaseRef, debitRef],
    );
    const refs = new Set(existing.rows.map((r) => r.ref as string));
    if (refs.has(debitRef)) return; // idempotent

    const lock = await client.query(
      `SELECT balance_paise FROM wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    let balance = parseInt(lock.rows[0]?.balance_paise ?? '0', 10);

    const releaseAmount = Math.max(0, holdPaise - actualCostPaise);
    const extraDebit = Math.max(0, actualCostPaise - holdPaise);

    if (releaseAmount > 0 && !refs.has(releaseRef)) {
      balance += releaseAmount;
      await client.query(
        `INSERT INTO wallet_transactions
           (txn_id, user_id, type, amount_paise, minutes, ref, status, balance_after, meta)
         VALUES ($1, $2, 'release', $3, NULL, $4, 'completed', $5, $6)`,
        [
          crypto.randomUUID(),
          userId,
          releaseAmount,
          releaseRef,
          balance,
          JSON.stringify({ masked_call_id: callId, billed_seconds: billedSeconds }),
        ],
      );
    }

    if (extraDebit > 0) {
      if (balance < extraDebit) {
        throw new AppError(402, 'INSUFFICIENT_BALANCE', 'Insufficient balance to settle call.');
      }
      balance -= extraDebit;
      await client.query(
        `INSERT INTO wallet_transactions
           (txn_id, user_id, type, amount_paise, minutes, ref, status, balance_after, meta)
         VALUES ($1, $2, 'debit', $3, $4, $5, 'completed', $6, $7)`,
        [
          crypto.randomUUID(),
          userId,
          extraDebit,
          Math.ceil(billedSeconds / 60),
          debitRef,
          balance,
          JSON.stringify({ masked_call_id: callId, billed_seconds: billedSeconds }),
        ],
      );
    } else if (!refs.has(debitRef)) {
      // Record zero-extra debit for audit trail
      await client.query(
        `INSERT INTO wallet_transactions
           (txn_id, user_id, type, amount_paise, minutes, ref, status, balance_after, meta)
         VALUES ($1, $2, 'debit', 0, $3, $4, 'completed', $5, $6)`,
        [
          crypto.randomUUID(),
          userId,
          Math.ceil(billedSeconds / 60),
          debitRef,
          balance,
          JSON.stringify({ masked_call_id: callId, billed_seconds: billedSeconds, from_hold: true }),
        ],
      );
    }

    await client.query(
      `UPDATE wallets SET balance_paise = $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, balance],
    );
  });
}

export async function createPaymentOrderRecord(
  userId: string,
  packId: string,
  razorpayOrderId: string,
  amountPaise?: number,
): Promise<{ order_id: string; amount_paise: number }> {
  const amount = amountPaise ?? packById(packId).amount_paise;
  const row = await queryOne<{ order_id: string }>(
    `INSERT INTO payment_orders (user_id, razorpay_order_id, amount_paise, pack_id)
     VALUES ($1, $2, $3, $4)
     RETURNING order_id`,
    [userId, razorpayOrderId, amount, packId],
  );
  return { order_id: row!.order_id, amount_paise: amount };
}

export async function activatePrivacyPack(
  userId: string,
  razorpayOrderId: string,
): Promise<void> {
  await query(
    `INSERT INTO privacy_subscriptions (user_id, plan, status, minutes_included, renews_at, razorpay_sub_id)
     VALUES ($1, 'privacy_pack', 'active', 300, NOW() + INTERVAL '30 days', $2)
     ON CONFLICT (user_id) DO UPDATE
       SET plan = 'privacy_pack', status = 'active',
           minutes_included = 300, renews_at = NOW() + INTERVAL '30 days',
           razorpay_sub_id = EXCLUDED.razorpay_sub_id, updated_at = NOW()`,
    [userId, razorpayOrderId],
  );
}

export async function markPaymentOrderPaid(
  razorpayOrderId: string,
): Promise<{ user_id: string; pack_id: string; amount_paise: number; order_id: string } | null> {
  return queryOne(
    `UPDATE payment_orders
     SET status = 'paid', paid_at = NOW()
     WHERE razorpay_order_id = $1 AND status = 'created'
     RETURNING user_id, pack_id, amount_paise::int, order_id`,
    [razorpayOrderId],
  );
}

export function estimateHoldPaise(holdMinutes: number, ratePaise: number): number {
  return holdMinutes * ratePaise;
}

export { estimateCostPaise, paiseToMinutes };
