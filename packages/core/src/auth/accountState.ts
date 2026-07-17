/**
 * Account-state gate. Pure decision logic shared by the auth guard and the
 * identity/onboarding modules — decides whether a given account status may hold an
 * authenticated session, and maps a blocked status to the right error.
 */
import { appError, type AppError } from '../http/errors';

export type AccountStatus =
  | 'active'
  | 'under_review'
  | 'restricted'
  | 'suspended'
  | 'banned'
  | 'ousted'
  | 'self_deleted';

/** Statuses that may authenticate (soft-restricted accounts still sign in). */
const CAN_AUTH: ReadonlySet<AccountStatus> = new Set(['active', 'under_review', 'restricted']);

export interface AuthAccount {
  accountStatus: AccountStatus;
  isActive?: boolean | null;
}

/** Returns an AppError if the account cannot authenticate, else null. */
export function authBlockReason(account: AuthAccount): AppError | null {
  const status = account.accountStatus;
  if (CAN_AUTH.has(status) && account.isActive !== false) return null;
  switch (status) {
    case 'suspended':
      return appError('ACCOUNT_SUSPENDED');
    case 'banned':
    case 'ousted':
      return appError('ACCOUNT_BANNED');
    case 'self_deleted':
      return appError('USER_INACTIVE', 'This account was deleted.');
    default:
      return appError('USER_INACTIVE');
  }
}

/** Throw if the account cannot authenticate. */
export function assertCanAuthenticate(account: AuthAccount): void {
  const reason = authBlockReason(account);
  if (reason) throw reason;
}
