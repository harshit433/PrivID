import { queryOne } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

export function normalizeHandle(input: string): string {
  return input.trim().toLowerCase().replace(/^@/, '');
}

function cleanToken(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, '');
}

export function handleMatchesLegalName(handle: string, legalName: string): boolean {
  const h = cleanToken(handle);
  const tokens = legalName
    .split(/\s+/)
    .map(cleanToken)
    .filter((t) => t.length >= 2);
  if (tokens.length === 0) return true;
  return tokens.some((token) => h.includes(token));
}

export async function validateHandleForUser(
  userId: string,
  legalName: string | null,
  rawHandle: string,
): Promise<string> {
  const handle = normalizeHandle(rawHandle);
  if (!/^[a-z0-9._]{3,30}$/.test(handle)) {
    throw new AppError(400, 'HANDLE_INVALID', 'Handles can use letters, numbers, dots and underscores.');
  }
  if (!legalName) {
    throw new AppError(409, 'IDENTITY_NOT_VERIFIED', 'Verify your identity before choosing a handle.');
  }
  if (!handleMatchesLegalName(handle, legalName)) {
    throw new AppError(
      400,
      'HANDLE_NAME_MISMATCH',
      `Your handle should be based on your verified name, ${legalName}.`,
    );
  }
  const taken = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM users WHERE handle = $1 AND user_id != $2`,
    [handle, userId],
  );
  if (taken) throw new AppError(409, 'HANDLE_TAKEN', `@${handle} is taken. Try another.`);
  return handle;
}

export async function checkHandleAvailability(
  userId: string,
  legalName: string | null,
  rawHandle: string,
): Promise<{ available: boolean; handle: string; reason?: string; code?: string }> {
  try {
    const handle = await validateHandleForUser(userId, legalName, rawHandle);
    return { available: true, handle };
  } catch (err) {
    if (err instanceof AppError && ['HANDLE_TAKEN', 'HANDLE_INVALID', 'HANDLE_NAME_MISMATCH'].includes(err.code)) {
      return { available: false, handle: normalizeHandle(rawHandle), reason: err.message, code: err.code };
    }
    throw err;
  }
}
