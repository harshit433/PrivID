import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import { getWalletBalancePaise } from './wallet';

export interface DeleteBalanceInfo {
  call_wallet_paise: number;
  referral_wallet_paise: number;
  total_paise: number;
}

export async function getDeleteBalanceInfo(userId: string): Promise<DeleteBalanceInfo> {
  const [callBal, refRow] = await Promise.all([
    getWalletBalancePaise(userId),
    queryOne<{ withdrawable_paise: string }>(
      `SELECT withdrawable_paise::text FROM referral_wallets WHERE user_id = $1`,
      [userId],
    ),
  ]);
  const referralBal = parseInt(refRow?.withdrawable_paise ?? '0', 10);
  return {
    call_wallet_paise: callBal,
    referral_wallet_paise: referralBal,
    total_paise: callBal + referralBal,
  };
}

export async function selfDeleteAccount(
  userId: string,
  confirmHandle: string,
  options?: { forfeit_balance?: boolean; reason?: string },
): Promise<{ deleted: boolean; already_deleted?: boolean }> {
  const user = await queryOne<UserRow>(
    `SELECT * FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user) throw new AppError(404, 'USER_NOT_FOUND', 'Account not found.');

  if (!user.is_active || user.account_status === 'self_deleted') {
    return { deleted: true, already_deleted: true };
  }

  if (confirmHandle.toLowerCase() !== user.handle.toLowerCase()) {
    throw new AppError(400, 'HANDLE_MISMATCH', 'The handle you entered does not match your account.');
  }

  const balances = await getDeleteBalanceInfo(userId);
  if (balances.total_paise > 0 && !options?.forfeit_balance) {
    throw new AppError(
      409,
      'BALANCE_REMAINING',
      'Withdraw or use your balance before deleting your account.',
      balances as unknown as Record<string, unknown>,
    );
  }

  const tombstoneId = `deleted_${user.user_id}`;
  const anonymousHash = crypto.createHash('sha256').update(tombstoneId).digest('hex');
  const purgeAt = new Date();
  purgeAt.setDate(purgeAt.getDate() + 30);

  await withTransaction(async (client) => {
    if (user.identity_id) {
      await client.query(
        `UPDATE identities
            SET status = 'self_deleted',
                current_user_id = NULL,
                last_handle = $2,
                deleted_at = NOW(),
                status_reason = $3
          WHERE identity_id = $1`,
        [user.identity_id, user.handle, options?.reason ?? 'User deleted account'],
      );
    }

    await client.query(
      `UPDATE users SET
         is_active = FALSE,
         account_status = 'self_deleted',
         account_status_reason = $2,
         account_status_updated_at = NOW(),
         handle = $3,
         display_name = 'Deleted Account',
         phone_e164 = $3,
         phone_hash = $4,
         avatar_url = NULL,
         email = NULL,
         bio = NULL,
         profession = NULL,
         organisation = NULL,
         address = NULL,
         business_info = NULL,
         deleted_at = NOW(),
         purge_scheduled_at = $5,
         updated_at = NOW()
       WHERE user_id = $1`,
      [
        user.user_id,
        options?.reason ?? 'User deleted account',
        tombstoneId,
        anonymousHash,
        purgeAt,
      ],
    );

    await client.query(`UPDATE refresh_tokens SET revoked = TRUE WHERE user_id = $1`, [user.user_id]);

    if (user.phone_e164) {
      await client.query(
        `UPDATE otp_sessions SET verified = TRUE WHERE phone_e164 = $1 AND verified = FALSE`,
        [user.phone_e164],
      );
    }

    await client.query(`DELETE FROM connections WHERE owner_id = $1`, [user.user_id]);
    await client.query(
      `UPDATE reachability_channels SET status = 'revoked' WHERE owner_id = $1`,
      [user.user_id],
    );
  });

  return { deleted: true };
}
