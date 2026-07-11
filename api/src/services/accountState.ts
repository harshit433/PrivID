import type { PoolClient } from 'pg';
import type { AccountStatus, IdentityStatus, UserRow } from '@trustroute/shared';
import { queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

export type AuthBlockReason = 'self_deleted' | 'suspended' | 'banned' | 'ousted';

export interface PublicAccountState {
  account_status: AccountStatus;
  identity_status?: IdentityStatus | null;
  reason?: string | null;
  appeal?: {
    appeal_id: string;
    status: string;
    created_at: string;
    resolved_at: string | null;
    resolution: string | null;
    reviewer_message?: string | null;
  } | null;
}

export function effectiveAccountStatus(user: Pick<UserRow,
  'account_status' | 'is_active' | 'is_under_review' | 'call_restriction_until'
>): AccountStatus {
  if (user.account_status) return user.account_status;
  if (!user.is_active) return 'suspended';
  if (user.is_under_review) return 'under_review';
  if (user.call_restriction_until && new Date(user.call_restriction_until) > new Date()) return 'restricted';
  return 'active';
}

export function assertCanAuthenticate(user: Pick<UserRow,
  'account_status' | 'is_active' | 'is_under_review' | 'call_restriction_until'
>): void {
  const status = effectiveAccountStatus(user);
  if (status === 'self_deleted') {
    throw new AppError(403, 'ACCOUNT_SELF_DELETED', 'This account was deleted. Verify your identity to recreate it.');
  }
  if (status === 'suspended') {
    throw new AppError(403, 'ACCOUNT_SUSPENDED', 'This account is suspended. You can request a review.');
  }
  if (status === 'banned' || status === 'ousted') {
    throw new AppError(403, 'ACCOUNT_BLOCKED', 'This identity cannot be reactivated. You can request a review.');
  }
  if (!user.is_active) {
    throw new AppError(403, 'ACCOUNT_INACTIVE', 'This account is not active. Please contact support.');
  }
}

export async function getLatestAppeal(params: {
  userId?: string | null;
  identityId?: string | null;
}): Promise<PublicAccountState['appeal']> {
  if (!params.userId && !params.identityId) return null;
  const row = await queryOne<{
    appeal_id: string;
    status: string;
    created_at: Date;
    resolved_at: Date | null;
    resolution: string | null;
    reviewer_message: string | null;
  }>(
    `SELECT appeal_id, status::text AS status, created_at, resolved_at, resolution, reviewer_message
       FROM account_appeals
      WHERE ($1::uuid IS NOT NULL AND user_id = $1)
         OR ($2::uuid IS NOT NULL AND identity_id = $2)
      ORDER BY created_at DESC
      LIMIT 1`,
    [params.userId ?? null, params.identityId ?? null],
  );
  if (!row) return null;
  return {
    appeal_id: row.appeal_id,
    status: row.status,
    created_at: new Date(row.created_at).toISOString(),
    resolved_at: row.resolved_at ? new Date(row.resolved_at).toISOString() : null,
    resolution: row.resolution,
    reviewer_message: row.reviewer_message ?? null,
  };
}

export async function setUserAccountStatus(
  client: PoolClient,
  userId: string,
  status: AccountStatus,
  reason?: string | null,
): Promise<void> {
  await client.query(
    `UPDATE users
        SET account_status = $2,
            account_status_reason = $3,
            account_status_updated_at = NOW(),
            is_active = CASE WHEN $2 IN ('active','under_review','restricted') THEN TRUE ELSE FALSE END,
            is_under_review = CASE WHEN $2 = 'under_review' THEN TRUE ELSE FALSE END,
            review_reason = CASE WHEN $2 = 'under_review' THEN $3 ELSE NULL END,
            review_started_at = CASE WHEN $2 = 'under_review' THEN NOW() ELSE NULL END,
            suspended_at = CASE WHEN $2 = 'suspended' THEN NOW() ELSE suspended_at END,
            banned_at = CASE WHEN $2 IN ('banned','ousted') THEN NOW() ELSE banned_at END,
            deleted_at = CASE WHEN $2 = 'self_deleted' THEN NOW() ELSE deleted_at END,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, status, reason ?? null],
  );
}

export async function setIdentityStatus(
  client: PoolClient,
  identityId: string,
  status: IdentityStatus,
  reason?: string | null,
): Promise<void> {
  await client.query(
    `UPDATE identities
        SET status = $2,
            status_reason = $3,
            banned_reason = CASE WHEN $2 IN ('banned','ousted','suspended') THEN $3 ELSE banned_reason END,
            deleted_at = CASE WHEN $2 = 'self_deleted' THEN NOW() ELSE deleted_at END,
            suspended_at = CASE WHEN $2 = 'suspended' THEN NOW() ELSE suspended_at END,
            updated_at = NOW()
      WHERE identity_id = $1`,
    [identityId, status, reason ?? null],
  );
}
