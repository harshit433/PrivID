/**
 * Referral-qualification scan (hourly). A referral sits in `qualifying` until the
 * referred user proves genuine — here: their account is active AND they have reached the
 * basic trust tier (trust_score ≥ 30, i.e. real verification, not a throwaway). On
 * qualification the referrer's pending reward is unlocked to withdrawable, mirrored in the
 * referral ledger + audit log, all in one transaction. Idempotent via the status guard.
 */
import {
  db,
  referrals,
  referralWallets,
  referralLedger,
  referralAuditEvents,
  users,
  eq,
  and,
  sql,
  logger,
  type JobMap,
} from '@trustroute/core';
import type { Processor } from 'bullmq';
import type { JobDescriptor } from '../workers';

const QUALIFY_MIN_TRUST = 30;

async function qualifyOne(referralId: string): Promise<boolean> {
  return db.transaction(async (tx) => {
    const [ref] = await tx
      .update(referrals)
      .set({ status: 'qualified', qualifiedAt: sql`now()`, updatedAt: sql`now()` })
      .where(and(eq(referrals.referralId, referralId), sql`${referrals.status} IN ('qualifying','verified')`))
      .returning();
    if (!ref) return false;

    await tx
      .update(referralWallets)
      .set({
        pendingPaise: sql`GREATEST(0, ${referralWallets.pendingPaise} - ${ref.rewardPaise})`,
        withdrawablePaise: sql`${referralWallets.withdrawablePaise} + ${ref.rewardPaise}`,
        withdrawalUnlocked: true,
        updatedAt: sql`now()`,
      })
      .where(eq(referralWallets.userId, ref.referrerId));
    await tx.insert(referralLedger).values({
      userId: ref.referrerId,
      amountPaise: ref.rewardPaise,
      entryType: 'pending_to_withdrawable',
      referenceId: referralId,
      description: 'Referral qualified',
    });
    await tx.insert(referralAuditEvents).values({ referralId, action: 'qualified', fromStatus: 'qualifying', toStatus: 'qualified' });
    return true;
  });
}

const process: Processor<JobMap['referral-qualification']> = async () => {
  const eligible = await db
    .select({ referralId: referrals.referralId })
    .from(referrals)
    .innerJoin(users, eq(users.userId, referrals.referredId))
    .where(sql`${referrals.status} = 'qualifying' AND ${users.accountStatus} = 'active' AND ${users.trustScore} >= ${QUALIFY_MIN_TRUST}`)
    .limit(500);

  let qualified = 0;
  for (const { referralId } of eligible) {
    try {
      if (await qualifyOne(referralId)) qualified++;
    } catch (err) {
      logger.warn('worker:referral-qualification', 'qualify failed', { referralId, error: (err as Error).message });
    }
  }
  if (qualified) logger.info('worker:referral-qualification', 'scan complete', { scanned: eligible.length, qualified });
};

export const referralQualification: JobDescriptor<'referral-qualification'> = { name: 'referral-qualification', process, concurrency: 1 };
