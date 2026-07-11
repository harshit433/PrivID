import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import {
  getReferralRewardPaise,
  getReferralMinWithdrawalPaise,
  getInviteBaseUrl,
  getReferralMinCalls,
  getReferralActiveDays,
} from './referralConfig';
import {
  maskInviteeName,
  statusHint,
  statusLabel,
  type ReferralMilestones,
  type ReferralStatus,
} from './referralQualification';
import { logReferralAudit } from './referralAudit';

const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateReferralCode(): string {
  const bytes = crypto.randomBytes(8);
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += CODE_ALPHABET[bytes[i]! % CODE_ALPHABET.length];
  }
  return code;
}

function normalizeCode(raw: string): string {
  return raw.trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
}

async function ensureWallet(userId: string): Promise<void> {
  await query(
    `INSERT INTO referral_wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
    [userId],
  );
}

export async function ensureReferralCode(userId: string): Promise<string> {
  const existing = await queryOne<{ code: string }>(
    `SELECT code FROM referral_codes WHERE user_id = $1`,
    [userId],
  );
  if (existing) return existing.code;

  for (let attempt = 0; attempt < 8; attempt++) {
    const code = generateReferralCode();
    try {
      await query(`INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)`, [userId, code]);
      await ensureWallet(userId);
      return code;
    } catch (err: unknown) {
      if ((err as { code?: string }).code === '23505') continue;
      throw err;
    }
  }
  throw new AppError(500, 'REFERRAL_CODE_FAILED', 'Could not generate referral code.');
}

export async function validateReferralCode(
  rawCode: string,
  refereeUserId: string,
): Promise<{ valid: true; referrer_handle: string } | { valid: false; reason: string }> {
  const code = normalizeCode(rawCode);
  if (code.length < 4) return { valid: false, reason: 'Enter a valid referral code.' };

  const referrer = await queryOne<{ user_id: string; handle: string; onboarding_complete: boolean }>(
    `SELECT u.user_id, u.handle, u.onboarding_complete
     FROM referral_codes rc JOIN users u ON u.user_id = rc.user_id
     WHERE UPPER(rc.code) = $1 AND u.is_active = TRUE`,
    [code],
  );
  if (!referrer) return { valid: false, reason: 'Referral code not found.' };
  if (referrer.user_id === refereeUserId) return { valid: false, reason: 'You cannot use your own referral code.' };
  if (!referrer.onboarding_complete) return { valid: false, reason: 'This referral code is not active yet.' };

  const alreadyUsed = await queryOne(`SELECT referral_id FROM referrals WHERE referred_id = $1`, [refereeUserId]);
  if (alreadyUsed) return { valid: false, reason: 'A referral was already applied to this account.' };

  return { valid: true, referrer_handle: referrer.handle };
}

export async function applyReferralOnOnboardingComplete(
  refereeUserId: string,
  rawCode: string,
): Promise<{ applied: boolean; referrer_handle?: string }> {
  const code = normalizeCode(rawCode);
  if (!code) return { applied: false };

  const validation = await validateReferralCode(code, refereeUserId);
  if (!validation.valid) throw new AppError(400, 'INVALID_REFERRAL_CODE', validation.reason);

  const referrer = await queryOne<{ user_id: string; handle: string }>(
    `SELECT u.user_id, u.handle FROM referral_codes rc JOIN users u ON u.user_id = rc.user_id WHERE UPPER(rc.code) = $1`,
    [code],
  );
  if (!referrer) throw new AppError(400, 'INVALID_REFERRAL_CODE', 'Referral code not found.');

  const reward = await getReferralRewardPaise();
  const kycRow = await queryOne<{ kyc_status: string }>(
    `SELECT kyc_status FROM users WHERE user_id = $1`,
    [refereeUserId],
  );
  const initialStatus: ReferralStatus = kycRow?.kyc_status === 'verified' ? 'verified' : 'invited';

  await withTransaction(async (client) => {
    const dup = await client.query(`SELECT referral_id FROM referrals WHERE referred_id = $1 FOR UPDATE`, [refereeUserId]);
    if (dup.rows.length > 0) throw new AppError(409, 'REFERRAL_ALREADY_APPLIED', 'Referral already applied.');

    const { rows } = await client.query<{ referral_id: string }>(
      `INSERT INTO referrals (referrer_id, referred_id, code, status, reward_paise, milestones)
       VALUES ($1, $2, $3, $4, $5, $6::jsonb)
       RETURNING referral_id`,
      [
        referrer.user_id,
        refereeUserId,
        code,
        initialStatus,
        reward,
        JSON.stringify({ kyc: initialStatus === 'verified', calls: 0, active_days: 0 }),
      ],
    );
    const referralId = rows[0]!.referral_id;
    await logReferralAudit({
      referralId,
      userId: referrer.user_id,
      action: 'referral_created',
      toStatus: initialStatus,
      meta: { referred_id: refereeUserId },
    });
  });

  await ensureReferralCode(referrer.user_id);
  await ensureReferralCode(refereeUserId);

  return { applied: true, referrer_handle: referrer.handle };
}

export interface ReferralHome {
  code: string;
  invite_link: string;
  reward_paise: number;
  reward_rupees: number;
  min_calls: number;
  active_days: number;
  min_withdrawal_paise: number;
  wallet: {
    available_paise: number;
    pending_paise: number;
    total_earned_paise: number;
    available_rupees: number;
    pending_rupees: number;
    total_earned_rupees: number;
  };
  invites_count: number;
  qualified_count: number;
  next_pending_estimate_paise: number;
}

export async function getReferralHome(userId: string): Promise<ReferralHome> {
  const code = await ensureReferralCode(userId);
  const [reward, minCalls, activeDays, minWithdraw, baseUrl] = await Promise.all([
    getReferralRewardPaise(),
    getReferralMinCalls(),
    getReferralActiveDays(),
    getReferralMinWithdrawalPaise(),
    getInviteBaseUrl(),
  ]);

  const wallet = await queryOne<{
    total_earned_paise: number;
    withdrawable_paise: number;
    pending_paise: number;
  }>(`SELECT total_earned_paise, withdrawable_paise, pending_paise FROM referral_wallets WHERE user_id = $1`, [userId]);

  const stats = await queryOne<{ total: string; qualified: string; pending_est: string }>(
    `SELECT
       COUNT(*)::text AS total,
       COUNT(*) FILTER (WHERE status IN ('qualified', 'paid'))::text AS qualified,
       (COUNT(*) FILTER (WHERE status IN ('invited', 'verified', 'qualifying')) * $2)::text AS pending_est
     FROM referrals WHERE referrer_id = $1`,
    [userId, reward],
  );

  const available = wallet?.withdrawable_paise ?? 0;
  const pendingWallet = wallet?.pending_paise ?? 0;
  const pendingEst = parseInt(stats?.pending_est ?? '0', 10);

  return {
    code,
    invite_link: `${baseUrl}?code=${code}`,
    reward_paise: reward,
    reward_rupees: reward / 100,
    min_calls: minCalls,
    active_days: activeDays,
    min_withdrawal_paise: minWithdraw,
    wallet: {
      available_paise: available,
      pending_paise: pendingWallet + pendingEst,
      total_earned_paise: wallet?.total_earned_paise ?? 0,
      available_rupees: available / 100,
      pending_rupees: (pendingWallet + pendingEst) / 100,
      total_earned_rupees: (wallet?.total_earned_paise ?? 0) / 100,
    },
    invites_count: parseInt(stats?.total ?? '0', 10),
    qualified_count: parseInt(stats?.qualified ?? '0', 10),
    next_pending_estimate_paise: pendingEst,
  };
}

export interface ReferralListItem {
  referral_id: string;
  display_name: string;
  handle_masked: string;
  status: ReferralStatus;
  status_label: string;
  status_hint: string;
  milestones: ReferralMilestones;
  created_at: string;
  qualified_at: string | null;
}

export async function listMyReferrals(userId: string): Promise<ReferralListItem[]> {
  const rows = await query<{
    referral_id: string;
    status: ReferralStatus;
    milestones: ReferralMilestones;
    created_at: Date;
    qualified_at: Date | null;
    display_name: string | null;
    handle: string;
  }>(
    `SELECT r.referral_id, r.status, r.milestones, r.created_at, r.qualified_at,
            u.display_name, u.handle
     FROM referrals r
     JOIN users u ON u.user_id = r.referred_id
     WHERE r.referrer_id = $1
     ORDER BY r.created_at DESC`,
    [userId],
  );

  return rows.map((r) => {
    const qualified = r.status === 'qualified' || r.status === 'paid';
    return {
      referral_id: r.referral_id,
      display_name: maskInviteeName(r.display_name, r.handle, qualified),
      handle_masked: `@${r.handle.slice(0, 2)}***`,
      status: r.status,
      status_label: statusLabel(r.status),
      status_hint: statusHint(r.status),
      milestones: r.milestones ?? {},
      created_at: new Date(r.created_at).toISOString(),
      qualified_at: r.qualified_at ? new Date(r.qualified_at).toISOString() : null,
    };
  });
}

export interface ReferralWalletView {
  available_paise: number;
  pending_paise: number;
  total_earned_paise: number;
  min_withdrawal_paise: number;
  ledger: {
    entry_id: string;
    amount_paise: number;
    entry_type: string;
    description: string | null;
    created_at: string;
  }[];
}

export async function getReferralWallet(userId: string): Promise<ReferralWalletView> {
  await ensureWallet(userId);
  const minWithdraw = await getReferralMinWithdrawalPaise();
  const home = await getReferralHome(userId);
  const ledger = await query<{
    entry_id: string;
    amount_paise: number;
    entry_type: string;
    description: string | null;
    created_at: Date;
  }>(
    `SELECT entry_id, amount_paise, entry_type, description, created_at
     FROM referral_ledger WHERE user_id = $1 ORDER BY created_at DESC LIMIT 100`,
    [userId],
  );

  return {
    available_paise: home.wallet.available_paise,
    pending_paise: home.wallet.pending_paise,
    total_earned_paise: home.wallet.total_earned_paise,
    min_withdrawal_paise: minWithdraw,
    ledger: ledger.map((e) => ({ ...e, created_at: new Date(e.created_at).toISOString() })),
  };
}

export async function convertToCallBalance(userId: string, amountPaise: number): Promise<void> {
  if (amountPaise <= 0) throw new AppError(400, 'INVALID_AMOUNT', 'Enter a valid amount.');

  await withTransaction(async (client) => {
    const { rows } = await client.query<{ withdrawable_paise: number }>(
      `SELECT withdrawable_paise FROM referral_wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const available = rows[0]?.withdrawable_paise ?? 0;
    if (amountPaise > available) throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Amount exceeds available balance.');

    await client.query(
      `UPDATE referral_wallets SET withdrawable_paise = withdrawable_paise - $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, amountPaise],
    );
    await client.query(
      `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, description)
       VALUES ($1, $2, 'convert_to_call', 'Moved to call balance')`,
      [userId, -amountPaise],
    );
    await client.query(
      `INSERT INTO wallets (user_id) VALUES ($1) ON CONFLICT (user_id) DO NOTHING`,
      [userId],
    );
    await client.query(
      `UPDATE wallets SET balance_paise = balance_paise + $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, amountPaise],
    );
    await client.query(
      `INSERT INTO wallet_transactions (user_id, type, amount_paise, status, meta)
       VALUES ($1, 'referral_credit', $2, 'completed', $3::jsonb)`,
      [userId, amountPaise, JSON.stringify({ source: 'referral_wallet' })],
    );
  });
}

// Legacy summary for backward compat during migration
export async function getReferralSummary(userId: string) {
  const home = await getReferralHome(userId);
  const wallet = await getReferralWallet(userId);
  return {
    code: home.code,
    invite_link: home.invite_link,
    reward_paise: home.reward_paise,
    reward_rupees: home.reward_rupees,
    wallet: {
      total_earned_paise: home.wallet.total_earned_paise,
      withdrawable_paise: home.wallet.available_paise,
      pending_paise: home.wallet.pending_paise,
      total_earned_rupees: home.wallet.total_earned_rupees,
      withdrawable_rupees: home.wallet.available_rupees,
      pending_rupees: home.wallet.pending_rupees,
    },
    referrals_count: home.invites_count,
    qualified_count: home.qualified_count,
    ledger: wallet.ledger,
    config: {
      min_calls: home.min_calls,
      active_days: home.active_days,
      min_withdrawal_paise: home.min_withdrawal_paise,
    },
  };
}
