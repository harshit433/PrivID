import { query, queryOne, withTransaction } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { getReferralMinWithdrawalPaise } from './referralConfig';
import { createPayout, payoutsAvailable } from './razorpayx';

export async function requestPayout(
  userId: string,
  amountPaise: number,
  methodId: string,
): Promise<{ payout_id: string; status: string }> {
  const min = await getReferralMinWithdrawalPaise();
  if (amountPaise < min) {
    throw new AppError(400, 'MIN_WITHDRAWAL', `Minimum withdrawal is ₹${min / 100}.`);
  }

  if (!(await payoutsAvailable())) {
    throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
  }

  const method = await queryOne<{
    method_id: string;
    verified: boolean;
    fund_account_ref: string | null;
    details_masked: string;
  }>(
    `SELECT method_id, verified, fund_account_ref, details_masked
     FROM payout_methods WHERE method_id = $1 AND user_id = $2`,
    [methodId, userId],
  );
  if (!method) throw new AppError(404, 'METHOD_NOT_FOUND', 'Payout method not found.');
  if (!method.verified || !method.fund_account_ref) {
    throw new AppError(400, 'METHOD_NOT_VERIFIED', 'Verify your payout method before withdrawing.');
  }

  return withTransaction(async (client) => {
    const { rows } = await client.query<{ withdrawable_paise: number }>(
      `SELECT withdrawable_paise FROM referral_wallets WHERE user_id = $1 FOR UPDATE`,
      [userId],
    );
    const available = rows[0]?.withdrawable_paise ?? 0;
    if (amountPaise > available) {
      throw new AppError(400, 'INSUFFICIENT_BALANCE', 'Withdrawal amount exceeds available balance.');
    }

    const { rows: pRows } = await client.query<{ payout_id: string }>(
      `INSERT INTO payouts (user_id, amount_paise, method_id, status)
       VALUES ($1, $2, $3, 'requested')
       RETURNING payout_id`,
      [userId, amountPaise, methodId],
    );
    const payoutId = pRows[0]!.payout_id;

    await client.query(
      `UPDATE referral_wallets SET withdrawable_paise = withdrawable_paise - $2, updated_at = NOW() WHERE user_id = $1`,
      [userId, amountPaise],
    );
    await client.query(
      `INSERT INTO referral_ledger (user_id, amount_paise, entry_type, reference_id, description)
       VALUES ($1, $2, 'payout', $3, $4)`,
      [userId, -amountPaise, payoutId, `Withdrawal to ${method.details_masked}`],
    );

    try {
      const razorpayRef = await createPayout({
        fundAccountId: method.fund_account_ref!,
        amountPaise,
        referenceId: payoutId,
      });
      await client.query(
        `UPDATE payouts SET razorpayx_ref = $2, status = 'processing', updated_at = NOW() WHERE payout_id = $1`,
        [payoutId, razorpayRef],
      );
      return { payout_id: payoutId, status: 'processing' };
    } catch {
      await client.query(
        `UPDATE payouts SET status = 'failed', failure_reason = 'Gateway unavailable', updated_at = NOW() WHERE payout_id = $1`,
        [payoutId],
      );
      await client.query(
        `UPDATE referral_wallets SET withdrawable_paise = withdrawable_paise + $2 WHERE user_id = $1`,
        [userId, amountPaise],
      );
      throw new AppError(503, 'PAYOUTS_UNAVAILABLE', 'Withdrawals are briefly unavailable — try again soon.');
    }
  });
}

export async function listPayouts(userId: string) {
  const rows = await query<{
    payout_id: string;
    amount_paise: number;
    status: string;
    failure_reason: string | null;
    created_at: Date;
    details_masked: string | null;
    type: string | null;
  }>(
    `SELECT p.payout_id, p.amount_paise, p.status, p.failure_reason, p.created_at,
            pm.details_masked, pm.type::text
     FROM payouts p
     LEFT JOIN payout_methods pm ON pm.method_id = p.method_id
     WHERE p.user_id = $1
     ORDER BY p.created_at DESC
     LIMIT 50`,
    [userId],
  );
  return rows.map((r) => ({
    ...r,
    created_at: new Date(r.created_at).toISOString(),
  }));
}
