import { query, queryOne, withTransaction } from '@trustroute/shared';
import {
  getReferralRewardPaise,
  getReferralMinCalls,
  getReferralActiveDays,
  MIN_COUNTED_CALL_SECONDS,
} from './referralConfig';
import { checkReferralFraud } from './referralFraud';
import { logReferralAudit } from './referralAudit';

export type ReferralStatus = 'invited' | 'verified' | 'qualifying' | 'qualified' | 'paid' | 'rejected';

export interface ReferralMilestones {
  kyc?: boolean;
  calls?: number;
  calls_required?: number;
  active_days?: number;
  active_days_required?: number;
}

async function countRealCalls(userId: string): Promise<number> {
  const row = await queryOne<{ c: string }>(
    `SELECT COUNT(*)::text AS c FROM calls
     WHERE (caller_id = $1 OR callee_id = $1)
       AND status = 'ended'
       AND duration_seconds >= $2`,
    [userId, MIN_COUNTED_CALL_SECONDS],
  );
  return parseInt(row?.c ?? '0', 10);
}

async function countActiveDays(userId: string, since: Date): Promise<number> {
  const row = await queryOne<{ days: string }>(
    `SELECT COUNT(DISTINCT date_trunc('day', ended_at))::text AS days
     FROM calls
     WHERE (caller_id = $1 OR callee_id = $1)
       AND status = 'ended'
       AND duration_seconds >= $2
       AND ended_at >= $3`,
    [userId, MIN_COUNTED_CALL_SECONDS, since],
  );
  return parseInt(row?.days ?? '0', 10);
}

async function isKycVerified(userId: string): Promise<boolean> {
  const row = await queryOne<{ kyc_status: string }>(
    `SELECT kyc_status FROM users WHERE user_id = $1`,
    [userId],
  );
  return row?.kyc_status === 'verified';
}

async function transitionReferral(
  referralId: string,
  referrerId: string,
  referredId: string,
  from: ReferralStatus,
  to: ReferralStatus,
  milestones: ReferralMilestones,
  extra?: { rejected_reason?: string; qualified_at?: Date },
): Promise<void> {
  await query(
    `UPDATE referrals SET status = $2, milestones = $3::jsonb,
            rejected_reason = COALESCE($4, rejected_reason),
            qualified_at = COALESCE($5, qualified_at),
            updated_at = NOW()
     WHERE referral_id = $1`,
    [
      referralId,
      to,
      JSON.stringify(milestones),
      extra?.rejected_reason ?? null,
      extra?.qualified_at ?? null,
    ],
  );
  await logReferralAudit({
    referralId,
    userId: referrerId,
    action: 'status_transition',
    fromStatus: from,
    toStatus: to,
    meta: { referred_id: referredId, milestones },
  });
}

async function creditReferrerOnPaid(
  referrerId: string,
  referralId: string,
  amountPaise: number,
): Promise<void> {
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO referral_wallets (user_id, total_earned_paise, withdrawable_paise)
       VALUES ($1, $2, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         total_earned_paise = referral_wallets.total_earned_paise + $2,
         withdrawable_paise = referral_wallets.withdrawable_paise + $2,
         updated_at = NOW()`,
      [referrerId, amountPaise],
    );
    await client.query(
      `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, reference_id, description)
       VALUES ($1, $2, 'earn', $3, $4)`,
      [referrerId, amountPaise, referralId, 'Referral reward — friend qualified'],
    );
  });
}

export async function evaluateReferral(referralId: string): Promise<void> {
  const ref = await queryOne<{
    referral_id: string;
    referrer_id: string;
    referred_id: string;
    status: ReferralStatus;
    milestones: ReferralMilestones;
    created_at: Date;
    reward_paise: number;
  }>(
    `SELECT referral_id, referrer_id, referred_id, status, milestones, created_at, reward_paise
     FROM referrals WHERE referral_id = $1`,
    [referralId],
  );
  if (!ref || ref.status === 'paid' || ref.status === 'rejected') return;

  const minCalls = await getReferralMinCalls();
  const activeDaysRequired = await getReferralActiveDays();
  const reward = ref.reward_paise || (await getReferralRewardPaise());

  const kyc = await isKycVerified(ref.referred_id);
  const calls = await countRealCalls(ref.referred_id);
  const activeDays = await countActiveDays(ref.referred_id, new Date(ref.created_at));

  const milestones: ReferralMilestones = {
    kyc,
    calls,
    calls_required: minCalls,
    active_days: activeDays,
    active_days_required: activeDaysRequired,
  };

  let status = ref.status;

  if (status === 'invited' && kyc) {
    await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'verified', milestones);
    status = 'verified';
  }

  if (status === 'verified' && kyc && calls >= minCalls) {
    const fraud = await checkReferralFraud(ref.referrer_id, ref.referred_id);
    if (!fraud.pass) {
      await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'rejected', milestones, {
        rejected_reason: fraud.reason,
      });
      return;
    }
    await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'qualifying', milestones);
    status = 'qualifying';
  }

  if (status === 'qualifying') {
    const daysSinceInvite = Math.floor(
      (Date.now() - new Date(ref.created_at).getTime()) / 86_400_000,
    );
    if (daysSinceInvite < activeDaysRequired) return;

    if (activeDays < Math.min(3, activeDaysRequired)) {
      await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'rejected', milestones, {
        rejected_reason: 'This invite did not qualify.',
      });
      return;
    }

    const fraud = await checkReferralFraud(ref.referrer_id, ref.referred_id);
    if (!fraud.pass) {
      await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'rejected', milestones, {
        rejected_reason: fraud.reason,
      });
      return;
    }

    await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'qualified', milestones, {
      qualified_at: new Date(),
    });
    status = 'qualified';
  }

  if (status === 'qualified') {
    await creditReferrerOnPaid(ref.referrer_id, referralId, reward);
    await transitionReferral(referralId, ref.referrer_id, ref.referred_id, status, 'paid', milestones);
  }
}

export async function runReferralQualificationScan(): Promise<{ evaluated: number }> {
  const rows = await query<{ referral_id: string }>(
    `SELECT referral_id FROM referrals
     WHERE status IN ('invited', 'verified', 'qualifying', 'qualified')
     ORDER BY updated_at ASC
     LIMIT 500`,
  );
  for (const r of rows) {
    try {
      await evaluateReferral(r.referral_id);
    } catch { /* continue scan */ }
  }
  return { evaluated: rows.length };
}

export function maskInviteeName(displayName: string | null, handle: string, qualified: boolean): string {
  if (qualified && displayName) return displayName;
  const base = displayName ?? handle;
  const parts = base.trim().split(/\s+/);
  if (parts.length >= 2) return `${parts[0]} ${parts[1]![0]}.`;
  return `${base.slice(0, 1)}***`;
}

export function statusLabel(status: ReferralStatus): string {
  switch (status) {
    case 'invited': return 'Joined';
    case 'verified': return 'Verifying';
    case 'qualifying': return 'Calling';
    case 'qualified': return 'Qualified';
    case 'paid': return 'Paid';
    case 'rejected': return 'Not eligible';
    default: return status;
  }
}

export function statusHint(status: ReferralStatus): string {
  switch (status) {
    case 'invited': return 'Waiting for identity verification';
    case 'verified': return 'Making real calls to qualify';
    case 'qualifying': return 'Active use period in progress';
    case 'qualified': return 'Reward processing';
    case 'paid': return 'You earned from this invite';
    case 'rejected': return "This invite didn't qualify";
    default: return '';
  }
}
