import { queryOne } from '@trustroute/shared';

async function flagNum(key: string, fallback: number): Promise<number> {
  const row = await queryOne<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = $1`, [key]);
  if (!row) return fallback;
  const v = row.value;
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = parseInt(v, 10);
    return Number.isFinite(n) ? n : fallback;
  }
  return fallback;
}

async function flagStr(key: string, fallback: string): Promise<string> {
  const row = await queryOne<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = $1`, [key]);
  if (!row) return fallback;
  const v = row.value;
  if (typeof v === 'string') return v.replace(/^"|"$/g, '');
  return fallback;
}

export async function getReferralRewardPaise(): Promise<number> {
  return flagNum('referral_reward_paise', 3_000);
}

export async function getReferralMinCalls(): Promise<number> {
  return flagNum('referral_min_calls', 5);
}

export async function getReferralActiveDays(): Promise<number> {
  return flagNum('referral_active_days', 30);
}

export async function getReferralMinWithdrawalPaise(): Promise<number> {
  return flagNum('referral_min_withdrawal_paise', 10_000);
}

export async function getReferralMaxPerDay(): Promise<number> {
  return flagNum('referral_max_per_day', 10);
}

export async function getReferralMaxPerWeek(): Promise<number> {
  return flagNum('referral_max_per_week', 30);
}

export async function getInviteBaseUrl(): Promise<string> {
  return flagStr('referral_invite_base_url', 'https://trustroute.app/invite');
}

export async function isRazorpayXEnabled(): Promise<boolean> {
  const row = await queryOne<{ value: unknown }>(`SELECT value FROM feature_flags WHERE key = 'razorpayx_enabled'`, []);
  if (!row) return true;
  const v = row.value;
  return v === true || v === 'true' || v === '"true"';
}

export const MIN_COUNTED_CALL_SECONDS = 10;
