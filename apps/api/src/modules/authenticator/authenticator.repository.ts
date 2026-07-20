/**
 * Authenticator cloud-backup repository. Resolves a user to their durable identity
 * and upserts / reads the single encrypted vault blob keyed to that identity.
 */
import { db, users, authenticatorBackups, eq, sql } from '@trustroute/core';

export type BackupRow = typeof authenticatorBackups.$inferSelect;

/** The durable identity anchor for a user, or null if they have no verified identity. */
export async function getIdentityId(userId: string): Promise<string | null> {
  const [row] = await db
    .select({ identityId: users.identityId })
    .from(users)
    .where(eq(users.userId, userId));
  return row?.identityId ?? null;
}

export async function getBackup(identityId: string): Promise<BackupRow | null> {
  const [row] = await db
    .select()
    .from(authenticatorBackups)
    .where(eq(authenticatorBackups.identityId, identityId));
  return row ?? null;
}

export async function upsertBackup(
  identityId: string,
  ciphertext: string,
  version: number,
): Promise<BackupRow> {
  const [row] = await db
    .insert(authenticatorBackups)
    .values({ identityId, ciphertext, version })
    .onConflictDoUpdate({
      target: authenticatorBackups.identityId,
      set: { ciphertext, version, updatedAt: sql`now()` },
    })
    .returning();
  return row!;
}

export async function deleteBackup(identityId: string): Promise<void> {
  await db.delete(authenticatorBackups).where(eq(authenticatorBackups.identityId, identityId));
}
