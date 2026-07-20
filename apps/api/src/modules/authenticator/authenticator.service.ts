/**
 * Authenticator cloud-backup service. Maps the authenticated user to their durable
 * identity and stores / returns the encrypted vault blob. Cloud backup requires a
 * verified identity (that's the whole point — recovery survives device loss), so a
 * user without one is refused with a clear message.
 */
import { appError } from '@trustroute/core';
import * as repo from './authenticator.repository';

async function requireIdentity(userId: string): Promise<string> {
  const identityId = await repo.getIdentityId(userId);
  if (!identityId) {
    throw appError(
      'FORBIDDEN',
      'Cloud backup needs a verified identity. Complete verification first.',
    );
  }
  return identityId;
}

export async function getBackup(userId: string) {
  const identityId = await requireIdentity(userId);
  const row = await repo.getBackup(identityId);
  if (!row) {
    return { exists: false as const };
  }
  return {
    exists: true as const,
    ciphertext: row.ciphertext,
    version: row.version,
    updatedAt: row.updatedAt,
  };
}

export async function putBackup(
  userId: string,
  input: { ciphertext: string; version?: number },
) {
  const identityId = await requireIdentity(userId);
  const row = await repo.upsertBackup(identityId, input.ciphertext, input.version ?? 1);
  return { version: row.version, updatedAt: row.updatedAt };
}

export async function deleteBackup(userId: string) {
  const identityId = await requireIdentity(userId);
  await repo.deleteBackup(identityId);
  return { deleted: true };
}
