/**
 * Wallet repository. Money is BIGINT paise; `wallet_transactions` is an append-only,
 * signed ledger (+credit / −debit·hold) and `balance_after` snapshots the running
 * balance. Every mutation locks the wallet row (SELECT … FOR UPDATE) and is idempotent
 * on `ref` so a replayed provider callback or client retry never double-applies.
 */
import {
  db,
  wallets,
  walletTransactions,
  paymentOrders,
  privacySubscriptions,
  eq,
  and,
  or,
  lt,
  sql,
  desc,
  appError,
} from '@trustroute/core';

export type WalletRow = typeof wallets.$inferSelect;
export type WalletTxnRow = typeof walletTransactions.$inferSelect;

type WalletTxnType = WalletTxnRow['type'];

export async function ensureWallet(userId: string): Promise<WalletRow> {
  const [row] = await db
    .insert(wallets)
    .values({ userId })
    .onConflictDoNothing({ target: wallets.userId })
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return existing!;
}

export async function getWallet(userId: string): Promise<WalletRow | null> {
  const [row] = await db.select().from(wallets).where(eq(wallets.userId, userId)).limit(1);
  return row ?? null;
}

export interface ApplyInput {
  type: WalletTxnType;
  /** Signed delta: positive credits, negative debits/holds. */
  amountPaise: number;
  ref?: string | null;
  minutes?: number | null;
  meta?: Record<string, unknown>;
}

/**
 * Apply a signed ledger entry atomically. Rejects an overdraw (balance would go < 0).
 * If `ref` was already applied, returns the prior entry unchanged (idempotent).
 */
export async function applyTxn(userId: string, input: ApplyInput): Promise<{ txn: WalletTxnRow; balanceAfter: number }> {
  return db.transaction(async (tx) => {
    // Idempotency: a prior entry with this ref wins.
    if (input.ref) {
      const [prior] = await tx
        .select()
        .from(walletTransactions)
        .where(and(eq(walletTransactions.userId, userId), eq(walletTransactions.ref, input.ref)))
        .limit(1);
      if (prior) return { txn: prior, balanceAfter: prior.balanceAfter ?? 0 };
    }

    // Lock the wallet row so concurrent debits serialize.
    const [locked] = await tx.execute(sql`SELECT balance_paise FROM wallets WHERE user_id = ${userId} FOR UPDATE`).then(
      (r) => r.rows as Array<{ balance_paise: string | number }>,
    );
    const current = locked ? Number(locked.balance_paise) : null;
    if (current === null) throw appError('NOT_FOUND', 'Wallet not found.');

    const next = current + input.amountPaise;
    if (next < 0) throw appError('INSUFFICIENT_BALANCE');

    await tx.update(wallets).set({ balancePaise: next, updatedAt: sql`now()` }).where(eq(wallets.userId, userId));
    const [txn] = await tx
      .insert(walletTransactions)
      .values({
        userId,
        type: input.type,
        amountPaise: input.amountPaise,
        minutes: input.minutes ?? null,
        ref: input.ref ?? null,
        balanceAfter: next,
        meta: (input.meta ?? {}) as WalletTxnRow['meta'],
      })
      .returning();
    return { txn: txn!, balanceAfter: next };
  });
}

// Convenience wrappers (signed amounts derived here).
export const credit = (userId: string, amount: number, type: WalletTxnType, ref?: string, meta?: Record<string, unknown>) =>
  applyTxn(userId, { type, amountPaise: Math.abs(amount), ref, meta });

export const debit = (userId: string, amount: number, type: WalletTxnType, ref?: string, meta?: Record<string, unknown>) =>
  applyTxn(userId, { type, amountPaise: -Math.abs(amount), ref, meta });

export async function listTransactions(
  userId: string,
  limit: number,
  cursor: { t: string; id: string } | null,
): Promise<WalletTxnRow[]> {
  const where = cursor
    ? and(
        eq(walletTransactions.userId, userId),
        or(
          lt(walletTransactions.createdAt, new Date(cursor.t)),
          and(eq(walletTransactions.createdAt, new Date(cursor.t)), lt(walletTransactions.txnId, cursor.id)),
        ),
      )
    : eq(walletTransactions.userId, userId);
  return db
    .select()
    .from(walletTransactions)
    .where(where)
    .orderBy(desc(walletTransactions.createdAt), desc(walletTransactions.txnId))
    .limit(limit + 1);
}

export async function setAutoRecharge(
  userId: string,
  input: { enabled: boolean; packId?: string | null; thresholdPaise?: number | null },
): Promise<WalletRow> {
  const [row] = await db
    .update(wallets)
    .set({
      autoRechargeEnabled: input.enabled,
      autoRechargePackId: input.packId ?? null,
      autoRechargeThresholdPaise: input.thresholdPaise ?? null,
      updatedAt: sql`now()`,
    })
    .where(eq(wallets.userId, userId))
    .returning();
  return row!;
}

// ── Payment orders ────────────────────────────────────────────────────────────

export async function createOrder(input: {
  userId: string;
  razorpayOrderId: string;
  amountPaise: number;
  packId: string;
}) {
  const [row] = await db.insert(paymentOrders).values(input).returning();
  return row!;
}

export async function findOrderByRazorpayId(razorpayOrderId: string) {
  const [row] = await db.select().from(paymentOrders).where(eq(paymentOrders.razorpayOrderId, razorpayOrderId)).limit(1);
  return row ?? null;
}

export async function markOrderPaid(orderId: string): Promise<boolean> {
  const rows = await db
    .update(paymentOrders)
    .set({ status: 'paid', paidAt: sql`now()` })
    .where(and(eq(paymentOrders.orderId, orderId), eq(paymentOrders.status, 'created')))
    .returning({ id: paymentOrders.orderId });
  return rows.length > 0;
}

// ── Privacy subscription ──────────────────────────────────────────────────────

export async function getSubscription(userId: string) {
  const [row] = await db.select().from(privacySubscriptions).where(eq(privacySubscriptions.userId, userId)).limit(1);
  return row ?? null;
}
