import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

export const REFERRER_BONUS_PAISE = 3_000;
export const REFEREE_BONUS_PAISE = 2_000;
export const MIN_COUNTED_CALL_SECONDS = 10;
export const WEEKLY_CALL_REQUIREMENT_SECONDS = 4_200; // 70 minutes
export const INSTALL_DAYS_REQUIRED = 30;
export const MIN_WITHDRAWAL_PAISE = 10_000; // ₹100

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
    `INSERT INTO referral_wallets (user_id)
     VALUES ($1)
     ON CONFLICT (user_id) DO NOTHING`,
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
      await query(
        `INSERT INTO referral_codes (user_id, code) VALUES ($1, $2)`,
        [userId, code],
      );
      await ensureWallet(userId);
      return code;
    } catch (err: unknown) {
      const pgCode = (err as { code?: string }).code;
      if (pgCode === '23505') continue; // unique violation
      throw err;
    }
  }
  throw new AppError(500, 'REFERRAL_CODE_FAILED', 'Could not generate referral code.');
}

async function getDeviceInstallAt(userId: string): Promise<Date | null> {
  const row = await queryOne<{ install_at: Date }>(
    `SELECT MIN(created_at) AS install_at
     FROM device_registrations
     WHERE user_id = $1`,
    [userId],
  );
  return row?.install_at ?? null;
}

async function getWeeklyCallSeconds(userId: string): Promise<number> {
  const row = await queryOne<{ total: string }>(
    `SELECT COALESCE(SUM(duration_seconds), 0)::text AS total
     FROM calls
     WHERE (caller_id = $1 OR callee_id = $1)
       AND status = 'ended'
       AND duration_seconds IS NOT NULL
       AND duration_seconds >= $2
       AND ended_at > NOW() - INTERVAL '7 days'`,
    [userId, MIN_COUNTED_CALL_SECONDS],
  );
  return parseInt(row?.total ?? '0', 10);
}

export interface ReferralEligibility {
  device_install_at: string | null;
  days_installed: number;
  days_required: number;
  weekly_call_seconds: number;
  weekly_call_required_seconds: number;
  weekly_call_minutes: number;
  weekly_call_required_minutes: number;
  device_requirement_met: boolean;
  weekly_call_requirement_met: boolean;
  withdrawal_unlocked: boolean;
  can_withdraw: boolean;
}

async function computeEligibility(userId: string): Promise<ReferralEligibility> {
  const installAt = await getDeviceInstallAt(userId);
  const weeklyCallSeconds = await getWeeklyCallSeconds(userId);

  let daysInstalled = 0;
  if (installAt) {
    daysInstalled = Math.floor((Date.now() - new Date(installAt).getTime()) / 86_400_000);
  }

  const wallet = await queryOne<{ withdrawal_unlocked: boolean }>(
    `SELECT withdrawal_unlocked FROM referral_wallets WHERE user_id = $1`,
    [userId],
  );

  const deviceMet = daysInstalled >= INSTALL_DAYS_REQUIRED;
  const weeklyMet = weeklyCallSeconds >= WEEKLY_CALL_REQUIREMENT_SECONDS;
  const unlocked = wallet?.withdrawal_unlocked ?? false;

  return {
    device_install_at: installAt ? new Date(installAt).toISOString() : null,
    days_installed: daysInstalled,
    days_required: INSTALL_DAYS_REQUIRED,
    weekly_call_seconds: weeklyCallSeconds,
    weekly_call_required_seconds: WEEKLY_CALL_REQUIREMENT_SECONDS,
    weekly_call_minutes: Math.floor(weeklyCallSeconds / 60),
    weekly_call_required_minutes: WEEKLY_CALL_REQUIREMENT_SECONDS / 60,
    device_requirement_met: deviceMet,
    weekly_call_requirement_met: weeklyMet,
    withdrawal_unlocked: unlocked,
    can_withdraw: unlocked && deviceMet && weeklyMet,
  };
}

/** Move pending → withdrawable once user first meets both gates. */
export async function syncWithdrawalEligibility(userId: string): Promise<ReferralEligibility> {
  await ensureWallet(userId);
  const eligibility = await computeEligibility(userId);

  if (
    !eligibility.withdrawal_unlocked
    && eligibility.device_requirement_met
    && eligibility.weekly_call_requirement_met
  ) {
    await withTransaction(async (client) => {
      const { rows } = await client.query<{ pending_paise: number }>(
        `SELECT pending_paise FROM referral_wallets
         WHERE user_id = $1 FOR UPDATE`,
        [userId],
      );
      const pending = rows[0]?.pending_paise ?? 0;
      if (pending > 0) {
        await client.query(
          `UPDATE referral_wallets
           SET pending_paise = 0,
               withdrawable_paise = withdrawable_paise + $2,
               withdrawal_unlocked = TRUE,
               updated_at = NOW()
           WHERE user_id = $1`,
          [userId, pending],
        );
        await client.query(
          `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, description)
           VALUES ($1, $2, 'pending_to_withdrawable', 'Withdrawal requirements met — balance unlocked')`,
          [userId, pending],
        );
      } else {
        await client.query(
          `UPDATE referral_wallets
           SET withdrawal_unlocked = TRUE, updated_at = NOW()
           WHERE user_id = $1`,
          [userId],
        );
      }
    });
    eligibility.withdrawal_unlocked = true;
    eligibility.can_withdraw = true;
  }

  return eligibility;
}

export async function validateReferralCode(
  rawCode: string,
  refereeUserId: string,
): Promise<{ valid: true; referrer_handle: string } | { valid: false; reason: string }> {
  const code = normalizeCode(rawCode);
  if (code.length < 4) {
    return { valid: false, reason: 'Enter a valid referral code.' };
  }

  const referrer = await queryOne<{ user_id: string; handle: string; onboarding_complete: boolean }>(
    `SELECT u.user_id, u.handle, u.onboarding_complete
     FROM referral_codes rc
     JOIN users u ON u.user_id = rc.user_id
     WHERE UPPER(rc.code) = $1 AND u.is_active = TRUE`,
    [code],
  );

  if (!referrer) {
    return { valid: false, reason: 'Referral code not found.' };
  }
  if (referrer.user_id === refereeUserId) {
    return { valid: false, reason: 'You cannot use your own referral code.' };
  }
  if (!referrer.onboarding_complete) {
    return { valid: false, reason: 'This referral code is not active yet.' };
  }

  const alreadyUsed = await queryOne(
    `SELECT event_id FROM referral_events WHERE referee_user_id = $1`,
    [refereeUserId],
  );
  if (alreadyUsed) {
    return { valid: false, reason: 'A referral bonus was already applied to this account.' };
  }

  return { valid: true, referrer_handle: referrer.handle };
}

async function creditWallet(
  client: import('pg').PoolClient,
  userId: string,
  amountPaise: number,
  entryType: 'referrer_bonus' | 'referee_bonus',
  referenceId: string,
  description: string,
  withdrawalUnlocked: boolean,
): Promise<void> {
  if (withdrawalUnlocked) {
    await client.query(
      `INSERT INTO referral_wallets (user_id, total_earned_paise, withdrawable_paise)
       VALUES ($1, $2, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         total_earned_paise = referral_wallets.total_earned_paise + EXCLUDED.total_earned_paise,
         withdrawable_paise = referral_wallets.withdrawable_paise + EXCLUDED.withdrawable_paise,
         updated_at = NOW()`,
      [userId, amountPaise],
    );
  } else {
    await client.query(
      `INSERT INTO referral_wallets (user_id, total_earned_paise, pending_paise)
       VALUES ($1, $2, $2)
       ON CONFLICT (user_id) DO UPDATE SET
         total_earned_paise = referral_wallets.total_earned_paise + EXCLUDED.total_earned_paise,
         pending_paise = referral_wallets.pending_paise + EXCLUDED.pending_paise,
         updated_at = NOW()`,
      [userId, amountPaise],
    );
  }

  await client.query(
    `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, reference_id, description)
     VALUES ($1, $2, $3, $4, $5)`,
    [userId, amountPaise, entryType, referenceId, description],
  );
}

export async function applyReferralOnOnboardingComplete(
  refereeUserId: string,
  rawCode: string,
): Promise<{ applied: boolean; referrer_handle?: string }> {
  const code = normalizeCode(rawCode);
  if (!code) return { applied: false };

  const validation = await validateReferralCode(code, refereeUserId);
  if (!validation.valid) {
    throw new AppError(400, 'INVALID_REFERRAL_CODE', validation.reason);
  }

  const referrer = await queryOne<{ user_id: string; handle: string }>(
    `SELECT u.user_id, u.handle
     FROM referral_codes rc
     JOIN users u ON u.user_id = rc.user_id
     WHERE UPPER(rc.code) = $1`,
    [code],
  );
  if (!referrer) {
    throw new AppError(400, 'INVALID_REFERRAL_CODE', 'Referral code not found.');
  }

  const referee = await queryOne<{ handle: string }>(
    `SELECT handle FROM users WHERE user_id = $1`,
    [refereeUserId],
  );
  const refereeHandle = referee?.handle ?? 'user';

  await withTransaction(async (client) => {
    const dup = await client.query(
      `SELECT event_id FROM referral_events WHERE referee_user_id = $1 FOR UPDATE`,
      [refereeUserId],
    );
    if (dup.rows.length > 0) {
      throw new AppError(409, 'REFERRAL_ALREADY_APPLIED', 'Referral bonus already applied.');
    }

    const { rows: eventRows } = await client.query<{ event_id: string }>(
      `INSERT INTO referral_events
         (referrer_user_id, referee_user_id, referral_code,
          referrer_bonus_paise, referee_bonus_paise)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING event_id`,
      [referrer.user_id, refereeUserId, code, REFERRER_BONUS_PAISE, REFEREE_BONUS_PAISE],
    );
    const eventId = eventRows[0]!.event_id;

    const referrerWallet = await client.query<{ withdrawal_unlocked: boolean }>(
      `SELECT withdrawal_unlocked FROM referral_wallets WHERE user_id = $1`,
      [referrer.user_id],
    );
    const refereeWallet = await client.query<{ withdrawal_unlocked: boolean }>(
      `SELECT withdrawal_unlocked FROM referral_wallets WHERE user_id = $1`,
      [refereeUserId],
    );

    await creditWallet(
      client,
      referrer.user_id,
      REFERRER_BONUS_PAISE,
      'referrer_bonus',
      eventId,
      `Referral bonus — @${refereeHandle} joined`,
      referrerWallet.rows[0]?.withdrawal_unlocked ?? false,
    );

    await creditWallet(
      client,
      refereeUserId,
      REFEREE_BONUS_PAISE,
      'referee_bonus',
      eventId,
      'Welcome bonus — signed up with a referral code',
      refereeWallet.rows[0]?.withdrawal_unlocked ?? false,
    );
  });

  await ensureReferralCode(referrer.user_id);
  await ensureReferralCode(refereeUserId);

  return { applied: true, referrer_handle: referrer.handle };
}

export interface ReferralLedgerEntry {
  entry_id: string;
  amount_paise: number;
  entry_type: string;
  description: string | null;
  created_at: string;
}

export interface ReferralSummary {
  code: string;
  wallet: {
    total_earned_paise: number;
    withdrawable_paise: number;
    pending_paise: number;
    total_earned_rupees: number;
    withdrawable_rupees: number;
    pending_rupees: number;
  };
  eligibility: ReferralEligibility;
  referrals_count: number;
  ledger: ReferralLedgerEntry[];
}

export async function getReferralSummary(userId: string): Promise<ReferralSummary> {
  const code = await ensureReferralCode(userId);
  const eligibility = await syncWithdrawalEligibility(userId);

  const wallet = await queryOne<{
    total_earned_paise: number;
    withdrawable_paise: number;
    pending_paise: number;
  }>(
    `SELECT total_earned_paise, withdrawable_paise, pending_paise
     FROM referral_wallets WHERE user_id = $1`,
    [userId],
  );

  const countRow = await queryOne<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM referral_events
     WHERE referrer_user_id = $1 AND status = 'credited'`,
    [userId],
  );

  const ledger = await query<ReferralLedgerEntry>(
    `SELECT entry_id, amount_paise, entry_type, description, created_at
     FROM referral_ledger
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [userId],
  );

  const total = wallet?.total_earned_paise ?? 0;
  const withdrawable = wallet?.withdrawable_paise ?? 0;
  const pending = wallet?.pending_paise ?? 0;

  return {
    code,
    wallet: {
      total_earned_paise: total,
      withdrawable_paise: withdrawable,
      pending_paise: pending,
      total_earned_rupees: total / 100,
      withdrawable_rupees: withdrawable / 100,
      pending_rupees: pending / 100,
    },
    eligibility,
    referrals_count: parseInt(countRow?.count ?? '0', 10),
    ledger: ledger.map((e) => ({
      ...e,
      created_at: new Date(e.created_at).toISOString(),
    })),
  };
}

export async function requestWithdrawal(
  userId: string,
  amountPaise: number,
  upiId: string,
): Promise<{ withdrawal_id: string; status: string }> {
  if (amountPaise < MIN_WITHDRAWAL_PAISE) {
    throw new AppError(400, 'MIN_WITHDRAWAL', `Minimum withdrawal is ₹${MIN_WITHDRAWAL_PAISE / 100}.`);
  }

  const eligibility = await syncWithdrawalEligibility(userId);
  if (!eligibility.withdrawal_unlocked) {
    throw new AppError(
      403,
      'WITHDRAWAL_LOCKED',
      'Complete 30 days on device and 70 minutes of calls this week to unlock withdrawals.',
    );
  }
  if (!eligibility.device_requirement_met || !eligibility.weekly_call_requirement_met) {
    throw new AppError(
      403,
      'WITHDRAWAL_REQUIREMENTS',
      'You need 30 days on your device and 70 minutes of calls in the last 7 days to withdraw.',
    );
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<{
      withdrawable_paise: number;
    }>(
      `SELECT withdrawable_paise FROM referral_wallets
       WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const available = rows[0]?.withdrawable_paise ?? 0;
    if (amountPaise > available) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Withdrawal amount exceeds available balance.');
    }

    const { rows: wRows } = await client.query<{ withdrawal_id: string }>(
      `INSERT INTO referral_withdrawals (user_id, amount_paise, upi_id)
       VALUES ($1, $2, $3)
       RETURNING withdrawal_id`,
      [userId, amountPaise, upiId.trim()],
    );
    const withdrawalId = wRows[0]!.withdrawal_id;

    await client.query(
      `UPDATE referral_wallets
       SET withdrawable_paise = withdrawable_paise - $2, updated_at = NOW()
       WHERE user_id = $1`,
      [userId, amountPaise],
    );

    await client.query(
      `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, reference_id, description)
       VALUES ($1, $2, 'withdrawal', $3, $4)`,
      [userId, -amountPaise, withdrawalId, `Withdrawal request — UPI ${upiId.trim()}`],
    );

    return { withdrawal_id: withdrawalId, status: 'requested' };
  });
}
