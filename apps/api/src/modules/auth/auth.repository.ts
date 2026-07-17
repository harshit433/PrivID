/**
 * Auth repository — refresh-token persistence. Tokens are stored only as SHA-256
 * hashes; the raw value never touches the database.
 */
import { db, refreshTokens, eq, and, sql } from '@trustroute/core';

export async function insertRefreshToken(input: {
  userId: string;
  tokenHash: string;
  expiresAt: Date;
  deviceId?: string | null;
}): Promise<void> {
  await db.insert(refreshTokens).values({
    userId: input.userId,
    tokenHash: input.tokenHash,
    expiresAt: input.expiresAt,
    deviceId: input.deviceId ?? null,
  });
}

export async function findActiveRefreshToken(
  tokenHash: string,
): Promise<{ userId: string; expiresAt: Date } | null> {
  const [row] = await db
    .select({ userId: refreshTokens.userId, expiresAt: refreshTokens.expiresAt })
    .from(refreshTokens)
    .where(and(eq(refreshTokens.tokenHash, tokenHash), eq(refreshTokens.revoked, false)))
    .limit(1);
  if (!row) return null;
  if (row.expiresAt.getTime() < Date.now()) return null;
  return row;
}

export async function revokeToken(tokenHash: string): Promise<void> {
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.tokenHash, tokenHash));
}

export async function revokeAllForUser(userId: string): Promise<void> {
  await db.update(refreshTokens).set({ revoked: true }).where(eq(refreshTokens.userId, userId));
}
