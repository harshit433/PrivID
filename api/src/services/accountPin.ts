import bcrypt from 'bcryptjs';
import { query, queryOne } from '@trustroute/shared';
import type { UserRow } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

const PIN_ROUNDS = 10;
const MAX_FAILED = 5;
const LOCK_MINUTES = 15;

export type UserWithPin = UserRow & {
  pin_hash: string | null;
  pin_set_at: Date | null;
  pin_failed_attempts: number;
  pin_locked_until: Date | null;
};

export function isValidPin(pin: string): boolean {
  return /^\d{6}$/.test(pin);
}

export function pinSet(user: Pick<UserWithPin, 'pin_hash'> | UserRow): boolean {
  return Boolean((user as UserWithPin).pin_hash);
}

export async function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, PIN_ROUNDS);
}

export async function verifyPin(pin: string, pinHash: string): Promise<boolean> {
  return bcrypt.compare(pin, pinHash);
}

export async function setUserPin(userId: string, pin: string): Promise<void> {
  if (!isValidPin(pin)) {
    throw new AppError(400, 'PIN_INVALID', 'PIN must be exactly 6 digits.');
  }
  const pinHash = await hashPin(pin);
  await query(
    `UPDATE users
        SET pin_hash = $2,
            pin_set_at = NOW(),
            pin_failed_attempts = 0,
            pin_locked_until = NULL,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, pinHash],
  );
}

export function assertPinNotLocked(user: UserWithPin): void {
  if (user.pin_locked_until && new Date(user.pin_locked_until) > new Date()) {
    const mins = Math.max(
      1,
      Math.ceil((new Date(user.pin_locked_until).getTime() - Date.now()) / 60000),
    );
    throw new AppError(
      429,
      'PIN_LOCKED',
      `Too many incorrect PIN attempts. Try again in about ${mins} minute${mins === 1 ? '' : 's'}.`,
    );
  }
}

/** Record a failed PIN attempt; locks after MAX_FAILED failures. */
export async function recordPinFailure(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET pin_failed_attempts = pin_failed_attempts + 1,
            pin_locked_until = CASE
              WHEN pin_failed_attempts + 1 >= $2
              THEN NOW() + make_interval(mins => $3::int)
              ELSE pin_locked_until
            END,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId, MAX_FAILED, LOCK_MINUTES],
  );
}

export async function clearPinFailures(userId: string): Promise<void> {
  await query(
    `UPDATE users
        SET pin_failed_attempts = 0,
            pin_locked_until = NULL,
            updated_at = NOW()
      WHERE user_id = $1`,
    [userId],
  );
}

export async function getUserByHandleForLogin(handle: string): Promise<UserWithPin | null> {
  const normalized = handle.trim().toLowerCase().replace(/^@/, '');
  return queryOne<UserWithPin>(
    `SELECT * FROM users WHERE handle = $1`,
    [normalized],
  );
}
