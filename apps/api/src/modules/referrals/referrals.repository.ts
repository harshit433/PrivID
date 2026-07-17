/**
 * Referrals repository (Refer & Earn). `referrals` is the relationship of record,
 * `referral_wallets` a per-user balance snapshot (pending → withdrawable), and
 * `referral_ledger` the append-only log. Payouts go out via RazorpayX. Money is paise.
 */
import {
  db,
  referralCodes,
  referralWallets,
  referrals,
  referralLedger,
  referralAuditEvents,
  payoutMethods,
  payouts,
  eq,
  and,
  sql,
  desc,
} from '@trustroute/core';

export type ReferralRow = typeof referrals.$inferSelect;
export type ReferralWalletRow = typeof referralWallets.$inferSelect;
export type PayoutMethodRow = typeof payoutMethods.$inferSelect;
export type PayoutRow = typeof payouts.$inferSelect;

// ── Codes ─────────────────────────────────────────────────────────────────────

export async function getCode(userId: string): Promise<string | null> {
  const [row] = await db.select().from(referralCodes).where(eq(referralCodes.userId, userId)).limit(1);
  return row?.code ?? null;
}

export async function setCode(userId: string, code: string): Promise<string> {
  const [row] = await db
    .insert(referralCodes)
    .values({ userId, code })
    .onConflictDoNothing({ target: referralCodes.userId })
    .returning();
  return row?.code ?? (await getCode(userId))!;
}

export async function findUserByCode(code: string): Promise<string | null> {
  const [row] = await db
    .select({ userId: referralCodes.userId })
    .from(referralCodes)
    .where(sql`upper(${referralCodes.code}) = upper(${code})`)
    .limit(1);
  return row?.userId ?? null;
}

// ── Wallets ───────────────────────────────────────────────────────────────────

export async function ensureWallet(userId: string): Promise<ReferralWalletRow> {
  const [row] = await db
    .insert(referralWallets)
    .values({ userId })
    .onConflictDoNothing({ target: referralWallets.userId })
    .returning();
  if (row) return row;
  const [existing] = await db.select().from(referralWallets).where(eq(referralWallets.userId, userId)).limit(1);
  return existing!;
}

export async function getWallet(userId: string): Promise<ReferralWalletRow | null> {
  const [row] = await db.select().from(referralWallets).where(eq(referralWallets.userId, userId)).limit(1);
  return row ?? null;
}

// ── Referrals ─────────────────────────────────────────────────────────────────

export async function findByReferred(referredId: string): Promise<ReferralRow | null> {
  const [row] = await db.select().from(referrals).where(eq(referrals.referredId, referredId)).limit(1);
  return row ?? null;
}

export async function findById(referralId: string): Promise<ReferralRow | null> {
  const [row] = await db.select().from(referrals).where(eq(referrals.referralId, referralId)).limit(1);
  return row ?? null;
}

export async function listByReferrer(referrerId: string): Promise<ReferralRow[]> {
  return db
    .select()
    .from(referrals)
    .where(eq(referrals.referrerId, referrerId))
    .orderBy(desc(referrals.createdAt));
}

/**
 * Create the referral + credit the referrer's pending balance + log both, atomically.
 * Returns null if the referee was already referred (unique constraint).
 */
export async function createReferralWithReward(input: {
  referrerId: string;
  referredId: string;
  code: string;
  rewardPaise: number;
  refereePaise: number;
}): Promise<ReferralRow | null> {
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .insert(referrals)
      .values({ referrerId: input.referrerId, referredId: input.referredId, code: input.code, status: 'qualifying', rewardPaise: input.rewardPaise })
      .onConflictDoNothing({ target: referrals.referredId })
      .returning();
    if (!ref) return null;

    // Referrer pending reward.
    await tx.insert(referralWallets).values({ userId: input.referrerId, pendingPaise: input.rewardPaise, totalEarnedPaise: input.rewardPaise })
      .onConflictDoUpdate({
        target: referralWallets.userId,
        set: {
          pendingPaise: sql`${referralWallets.pendingPaise} + ${input.rewardPaise}`,
          totalEarnedPaise: sql`${referralWallets.totalEarnedPaise} + ${input.rewardPaise}`,
          updatedAt: sql`now()`,
        },
      });
    await tx.insert(referralLedger).values({ userId: input.referrerId, amountPaise: input.rewardPaise, entryType: 'referrer_bonus', referenceId: ref.referralId, description: 'Referral pending reward' });

    // Referee pending bonus.
    if (input.refereePaise > 0) {
      await tx.insert(referralWallets).values({ userId: input.referredId, pendingPaise: input.refereePaise, totalEarnedPaise: input.refereePaise })
        .onConflictDoUpdate({
          target: referralWallets.userId,
          set: {
            pendingPaise: sql`${referralWallets.pendingPaise} + ${input.refereePaise}`,
            totalEarnedPaise: sql`${referralWallets.totalEarnedPaise} + ${input.refereePaise}`,
            updatedAt: sql`now()`,
          },
        });
      await tx.insert(referralLedger).values({ userId: input.referredId, amountPaise: input.refereePaise, entryType: 'referee_bonus', referenceId: ref.referralId, description: 'Signup bonus' });
    }

    await tx.insert(referralAuditEvents).values({ referralId: ref.referralId, userId: input.referredId, action: 'created', toStatus: 'qualifying' });
    return ref;
  });
}

/**
 * Qualify a referral: move both parties' reward from pending → withdrawable and unlock
 * withdrawal. Called by the referral-qualification worker (P8) on milestone; idempotent.
 */
export async function qualifyReferral(referralId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .update(referrals)
      .set({ status: 'qualified', qualifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(referrals.referralId, referralId), sql`${referrals.status} IN ('qualifying','verified')`))
      .returning();
    if (!ref) return false;

    const move = async (userId: string, amount: number) => {
      await tx
        .update(referralWallets)
        .set({
          pendingPaise: sql`GREATEST(0, ${referralWallets.pendingPaise} - ${amount})`,
          withdrawablePaise: sql`${referralWallets.withdrawablePaise} + ${amount}`,
          withdrawalUnlocked: true,
          updatedAt: sql`now()`,
        })
        .where(eq(referralWallets.userId, userId));
      await tx.insert(referralLedger).values({ userId, amountPaise: amount, entryType: 'pending_to_withdrawable', referenceId: referralId, description: 'Referral qualified' });
    };
    await move(ref.referrerId, ref.rewardPaise);
    await tx.insert(referralAuditEvents).values({ referralId, action: 'qualified', fromStatus: 'qualifying', toStatus: 'qualified' });
    return true;
  });
}

// ── Payout methods ────────────────────────────────────────────────────────────

export async function addPayoutMethod(input: {
  userId: string;
  type: 'upi' | 'bank';
  detailsMasked: string;
  holderName?: string | null;
  isDefault: boolean;
}): Promise<PayoutMethodRow> {
  return db.transaction(async (tx) => {
    if (input.isDefault) {
      await tx.update(payoutMethods).set({ isDefault: false }).where(eq(payoutMethods.userId, input.userId));
    }
    const [row] = await tx
      .insert(payoutMethods)
      .values({ userId: input.userId, type: input.type, detailsMasked: input.detailsMasked, holderName: input.holderName ?? null, isDefault: input.isDefault })
      .returning();
    return row!;
  });
}

export async function listPayoutMethods(userId: string): Promise<PayoutMethodRow[]> {
  return db.select().from(payoutMethods).where(eq(payoutMethods.userId, userId)).orderBy(desc(payoutMethods.createdAt));
}

export async function findPayoutMethod(userId: string, methodId: string): Promise<PayoutMethodRow | null> {
  const [row] = await db
    .select()
    .from(payoutMethods)
    .where(and(eq(payoutMethods.methodId, methodId), eq(payoutMethods.userId, userId)))
    .limit(1);
  return row ?? null;
}

export async function removePayoutMethod(userId: string, methodId: string): Promise<boolean> {
  const rows = await db
    .delete(payoutMethods)
    .where(and(eq(payoutMethods.methodId, methodId), eq(payoutMethods.userId, userId)))
    .returning({ id: payoutMethods.methodId });
  return rows.length > 0;
}

// ── Payouts ───────────────────────────────────────────────────────────────────

/**
 * Debit withdrawable and create a payout row atomically. Throws (via the caller's
 * balance check) if funds are insufficient; the DB check keeps balances non-negative.
 */
export async function createPayout(input: {
  userId: string;
  amountPaise: number;
  methodId: string;
  razorpayxRef: string | null;
}): Promise<PayoutRow> {
  return db.transaction(async (tx) => {
    const debited = await tx
      .update(referralWallets)
      .set({ withdrawablePaise: sql`${referralWallets.withdrawablePaise} - ${input.amountPaise}`, updatedAt: sql`now()` })
      .where(and(eq(referralWallets.userId, input.userId), sql`${referralWallets.withdrawablePaise} >= ${input.amountPaise}`))
      .returning({ id: referralWallets.userId });
    if (debited.length === 0) throw new Error('INSUFFICIENT_WITHDRAWABLE');

    const [payout] = await tx
      .insert(payouts)
      .values({ userId: input.userId, amountPaise: input.amountPaise, methodId: input.methodId, razorpayxRef: input.razorpayxRef, status: 'processing' })
      .returning();
    await tx.insert(referralLedger).values({ userId: input.userId, amountPaise: -input.amountPaise, entryType: 'withdrawal', referenceId: payout!.payoutId, description: 'Payout requested' });
    return payout!;
  });
}

export async function listPayouts(userId: string): Promise<PayoutRow[]> {
  return db.select().from(payouts).where(eq(payouts.userId, userId)).orderBy(desc(payouts.createdAt));
}
