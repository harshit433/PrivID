import crypto from 'crypto';
import { query, queryOne, withTransaction } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import {
  createFundAccountBank,
  createFundAccountUpi,
  createRazorpayContact,
} from './razorpayx';

function maskUpi(upi: string): string {
  const [user, domain] = upi.split('@');
  if (!domain) return '***';
  return `${user!.slice(0, 2)}***@${domain}`;
}

function maskBank(account: string): string {
  if (account.length <= 4) return '****';
  return `****${account.slice(-4)}`;
}

export async function listPayoutMethods(userId: string) {
  const rows = await query<{
    method_id: string;
    type: 'upi' | 'bank';
    details_masked: string;
    holder_name: string | null;
    verified: boolean;
    is_default: boolean;
    created_at: Date;
  }>(
    `SELECT method_id, type, details_masked, holder_name, verified, is_default, created_at
     FROM payout_methods WHERE user_id = $1 ORDER BY is_default DESC, created_at DESC`,
    [userId],
  );
  return rows.map((r) => ({ ...r, created_at: new Date(r.created_at).toISOString() }));
}

export async function addPayoutMethodUpi(userId: string, upiId: string): Promise<{ method_id: string; verified: boolean }> {
  const upi = upiId.trim().toLowerCase();
  if (!/^[\w.-]+@[\w.-]+$/.test(upi)) {
    throw new AppError(400, 'INVALID_UPI', 'Enter a valid UPI ID.');
  }

  const user = await queryOne<{ legal_name: string | null; display_name: string | null; handle: string; email: string | null }>(
    `SELECT legal_name, display_name, handle, email FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user) throw new AppError(404, 'NOT_FOUND', 'User not found.');

  const holderName = user.legal_name ?? user.display_name ?? user.handle;
  const contactId = await createRazorpayContact(userId, holderName, user.email ?? undefined);
  const fundRef = await createFundAccountUpi({ contactId, upiId: upi });

  const row = await queryOne<{ method_id: string }>(
    `INSERT INTO payout_methods (user_id, type, details_masked, holder_name, verified, fund_account_ref, razorpay_contact_ref, is_default)
     VALUES ($1, 'upi', $2, $3, TRUE, $4, $5,
       (SELECT COUNT(*) = 0 FROM payout_methods pm WHERE pm.user_id = $1))
     RETURNING method_id`,
    [userId, maskUpi(upi), holderName, fundRef, contactId],
  );
  return { method_id: row!.method_id, verified: true };
}

export async function addPayoutMethodBank(
  userId: string,
  params: { account_number: string; ifsc: string; holder_name: string },
): Promise<{ method_id: string; verified: boolean }> {
  const ifsc = params.ifsc.trim().toUpperCase();
  if (!/^[A-Z]{4}0[A-Z0-9]{6}$/.test(ifsc)) {
    throw new AppError(400, 'INVALID_IFSC', 'Enter a valid IFSC code.');
  }

  const user = await queryOne<{ legal_name: string | null; kyc_status: string }>(
    `SELECT legal_name, kyc_status FROM users WHERE user_id = $1`,
    [userId],
  );
  if (!user || user.kyc_status !== 'verified') {
    throw new AppError(403, 'KYC_REQUIRED', 'Complete identity verification before adding a bank account.');
  }

  const kycName = (user.legal_name ?? '').trim().toLowerCase();
  const holder = params.holder_name.trim();
  if (kycName && holder.toLowerCase() !== kycName) {
    throw new AppError(
      400,
      'NAME_MISMATCH',
      `The name must match your verified name, ${user.legal_name}.`,
    );
  }

  const contactId = await createRazorpayContact(userId, holder);
  const fundRef = await createFundAccountBank({
    contactId,
    name: holder,
    ifsc,
    accountNumber: params.account_number.trim(),
  });

  const row = await queryOne<{ method_id: string }>(
    `INSERT INTO payout_methods (user_id, type, details_masked, holder_name, verified, fund_account_ref, razorpay_contact_ref, is_default)
     VALUES ($1, 'bank', $2, $3, TRUE, $4, $5,
       (SELECT COUNT(*) = 0 FROM payout_methods pm WHERE pm.user_id = $1))
     RETURNING method_id`,
    [userId, maskBank(params.account_number), holder, fundRef, contactId],
  );
  return { method_id: row!.method_id, verified: true };
}

export async function deletePayoutMethod(userId: string, methodId: string): Promise<void> {
  const existing = await queryOne(
    `SELECT method_id FROM payout_methods WHERE method_id = $1 AND user_id = $2`,
    [methodId, userId],
  );
  if (!existing) throw new AppError(404, 'NOT_FOUND', 'Payout method not found.');
  await query(`DELETE FROM payout_methods WHERE method_id = $1 AND user_id = $2`, [methodId, userId]);
}
