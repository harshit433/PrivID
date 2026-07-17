/**
 * Identity repository — the government-verified anchor. `doc_hash` is unique so one
 * identity maps to at most one active account.
 */
import { db, identities, eq, sql } from '@trustroute/core';

export type IdentityRow = typeof identities.$inferSelect;

export async function findByDocHash(docHash: string): Promise<IdentityRow | null> {
  const [row] = await db.select().from(identities).where(eq(identities.docHash, docHash)).limit(1);
  return row ?? null;
}

export async function findById(identityId: string): Promise<IdentityRow | null> {
  const [row] = await db.select().from(identities).where(eq(identities.identityId, identityId)).limit(1);
  return row ?? null;
}

export async function createIdentity(input: {
  legalName: string;
  docType?: string;
  docHash: string;
  provider?: string;
  providerRef?: string | null;
  faceRef?: string | null;
}): Promise<IdentityRow> {
  const [row] = await db
    .insert(identities)
    .values({
      legalName: input.legalName,
      docType: input.docType ?? 'aadhaar',
      docHash: input.docHash,
      provider: input.provider ?? 'setu',
      providerRef: input.providerRef ?? null,
      faceRef: input.faceRef ?? null,
      status: 'active',
    })
    .returning();
  return row!;
}

export async function setCurrentUser(identityId: string, userId: string | null, lastHandle?: string): Promise<void> {
  await db
    .update(identities)
    .set({ currentUserId: userId, ...(lastHandle ? { lastHandle } : {}), updatedAt: sql`now()` })
    .where(eq(identities.identityId, identityId));
}

export async function setStatus(
  identityId: string,
  status: IdentityRow['status'],
  reason?: string,
): Promise<void> {
  await db
    .update(identities)
    .set({ status, statusReason: reason ?? null, updatedAt: sql`now()` })
    .where(eq(identities.identityId, identityId));
}
