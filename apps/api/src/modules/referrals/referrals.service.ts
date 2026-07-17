/**
 * Referrals service: issue codes, apply a code (credits pending rewards), report status,
 * manage payout methods, and request payouts (RazorpayX). Qualification (pending →
 * withdrawable) is driven by the worker; exposed here as `qualify` for it to call.
 */
import crypto from 'crypto';
import { appError, getPayoutsProvider } from '@trustroute/core';
import * as repo from './referrals.repository';
import type { ReferralRow, PayoutMethodRow, PayoutRow } from './referrals.repository';

const REFERRER_REWARD_PAISE = 3000;
const REFEREE_BONUS_PAISE = 1000;
const MIN_PAYOUT_PAISE = 5000;

function genCode(): string {
  // 8-char uppercase alnum, ambiguity-free enough for sharing.
  return crypto.randomBytes(6).toString('base64').replace(/[^A-Za-z0-9]/g, '').slice(0, 8).toUpperCase();
}

export async function myCode(userId: string) {
  let code = await repo.getCode(userId);
  if (!code) {
    // Retry a couple times on the (rare) code collision.
    for (let i = 0; i < 3 && !code; i++) {
      try {
        code = await repo.setCode(userId, genCode());
      } catch {
        /* collision — retry */
      }
    }
    if (!code) throw appError('INTERNAL_ERROR', 'Could not allocate a referral code.');
  }
  return { code, shareUrl: `https://trustroute.app/r/${code}` };
}

export async function apply(referredUserId: string, code: string) {
  const referrerId = await repo.findUserByCode(code);
  if (!referrerId) throw appError('NOT_FOUND', 'That referral code is not valid.');
  if (referrerId === referredUserId) throw appError('BAD_REQUEST', 'You cannot refer yourself.');
  if (await repo.findByReferred(referredUserId)) throw appError('CONFLICT', 'You have already used a referral code.');

  const ref = await repo.createReferralWithReward({
    referrerId,
    referredId: referredUserId,
    code,
    rewardPaise: REFERRER_REWARD_PAISE,
    refereePaise: REFEREE_BONUS_PAISE,
  });
  if (!ref) throw appError('CONFLICT', 'You have already used a referral code.');
  return { referralId: ref.referralId, status: ref.status, bonusPaise: REFEREE_BONUS_PAISE };
}

function referralView(r: ReferralRow) {
  return { referralId: r.referralId, referredId: r.referredId, status: r.status, rewardPaise: r.rewardPaise, qualifiedAt: r.qualifiedAt, createdAt: r.createdAt };
}

export async function status(userId: string) {
  const [wallet, code, refs] = await Promise.all([
    repo.ensureWallet(userId),
    myCode(userId),
    repo.listByReferrer(userId),
  ]);
  return {
    code: code.code,
    shareUrl: code.shareUrl,
    wallet: {
      totalEarnedPaise: wallet.totalEarnedPaise,
      withdrawablePaise: wallet.withdrawablePaise,
      pendingPaise: wallet.pendingPaise,
      withdrawalUnlocked: wallet.withdrawalUnlocked,
    },
    referrals: refs.map(referralView),
  };
}

/** Worker entry point (P8): move a qualifying referral to qualified + unlock funds. */
export async function qualify(referralId: string) {
  return repo.qualifyReferral(referralId);
}

// ── Payout methods ────────────────────────────────────────────────────────────

function methodView(m: PayoutMethodRow) {
  return { methodId: m.methodId, type: m.type, detailsMasked: m.detailsMasked, holderName: m.holderName, verified: m.verified, isDefault: m.isDefault, createdAt: m.createdAt };
}

/** Store only a masked form of the destination (never the full UPI/account number). */
function maskDetails(type: 'upi' | 'bank', value: string): string {
  if (type === 'upi') {
    const [name, handle] = value.split('@');
    return `${(name ?? '').slice(0, 2)}***@${handle ?? ''}`;
  }
  return `****${value.slice(-4)}`;
}

export async function addPayoutMethod(
  userId: string,
  input: { type: 'upi' | 'bank'; value: string; holderName?: string; isDefault?: boolean },
) {
  const m = await repo.addPayoutMethod({
    userId,
    type: input.type,
    detailsMasked: maskDetails(input.type, input.value),
    holderName: input.holderName ?? null,
    isDefault: input.isDefault ?? false,
  });
  return methodView(m);
}

export async function listPayoutMethods(userId: string) {
  return { methods: (await repo.listPayoutMethods(userId)).map(methodView) };
}

export async function removePayoutMethod(userId: string, methodId: string) {
  if (!(await repo.removePayoutMethod(userId, methodId))) throw appError('NOT_FOUND', 'Payout method not found.');
  return { removed: true };
}

// ── Payouts ───────────────────────────────────────────────────────────────────

function payoutView(p: PayoutRow) {
  return { payoutId: p.payoutId, amountPaise: p.amountPaise, status: p.status, methodId: p.methodId, createdAt: p.createdAt };
}

export async function requestPayout(userId: string, input: { amountPaise: number; methodId: string }) {
  if (input.amountPaise < MIN_PAYOUT_PAISE) throw appError('BAD_REQUEST', `Minimum payout is ₹${MIN_PAYOUT_PAISE / 100}.`);
  const wallet = await repo.ensureWallet(userId);
  if (!wallet.withdrawalUnlocked) throw appError('FORBIDDEN', 'Withdrawals are not unlocked yet.');
  if (wallet.withdrawablePaise < input.amountPaise) throw appError('INSUFFICIENT_BALANCE', 'Not enough withdrawable balance.');

  const method = await repo.findPayoutMethod(userId, input.methodId);
  if (!method) throw appError('NOT_FOUND', 'Payout method not found.');

  const provider = getPayoutsProvider();
  const handle = await provider.createPayout({
    amountPaise: input.amountPaise,
    fundAccountRef: method.fundAccountRef ?? undefined,
    idempotencyKey: `${userId}:${input.methodId}:${input.amountPaise}:${Date.now()}`,
  });

  try {
    const payout = await repo.createPayout({ userId, amountPaise: input.amountPaise, methodId: input.methodId, razorpayxRef: handle.payoutRef });
    return payoutView(payout);
  } catch (err) {
    if ((err as Error).message === 'INSUFFICIENT_WITHDRAWABLE') throw appError('INSUFFICIENT_BALANCE');
    throw err;
  }
}

export async function listPayouts(userId: string) {
  return { payouts: (await repo.listPayouts(userId)).map(payoutView) };
}
