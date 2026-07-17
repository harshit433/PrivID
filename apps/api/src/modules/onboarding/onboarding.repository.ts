/**
 * Onboarding repository — the only place that reads/writes onboarding_sessions, and
 * the transactional home for turning a verified session into an identity + user.
 * Ephemeral face-match images live on the session row and are purged on completion.
 */
import { db, onboardingSessions, identities, users, eq, sql } from '@trustroute/core';
import type { IdentityRow } from '../identity/identity.repository';
import type { UserRow } from '../users/users.repository';

export type OnboardingSession = typeof onboardingSessions.$inferSelect;

export async function create(input: {
  purpose: string;
  deviceFingerprintHash?: string | null;
  integrityVerdict?: unknown;
  status?: string;
}): Promise<OnboardingSession> {
  const [row] = await db
    .insert(onboardingSessions)
    .values({
      purpose: input.purpose,
      status: input.status ?? 'device_checked',
      deviceFingerprintHash: input.deviceFingerprintHash ?? null,
      ...(input.integrityVerdict !== undefined
        ? { integrityVerdict: input.integrityVerdict as OnboardingSession['integrityVerdict'] }
        : {}),
    })
    .returning();
  return row!;
}

export async function findById(sessionId: string): Promise<OnboardingSession | null> {
  const [row] = await db
    .select()
    .from(onboardingSessions)
    .where(eq(onboardingSessions.sessionId, sessionId))
    .limit(1);
  return row ?? null;
}

export async function patch(
  sessionId: string,
  set: Partial<typeof onboardingSessions.$inferInsert>,
): Promise<OnboardingSession> {
  const [row] = await db
    .update(onboardingSessions)
    .set({ ...set, updatedAt: sql`now()` })
    .where(eq(onboardingSessions.sessionId, sessionId))
    .returning();
  return row!;
}

/** Purge the ephemeral face images and stamp completion. */
export async function markCompleted(sessionId: string): Promise<void> {
  await db
    .update(onboardingSessions)
    .set({
      status: 'completed',
      completedAt: sql`now()`,
      docPhotoB64: null,
      selfieB64: null,
      updatedAt: sql`now()`,
    })
    .where(eq(onboardingSessions.sessionId, sessionId));
}

export async function handleTaken(handle: string): Promise<boolean> {
  const [row] = await db
    .select({ userId: users.userId })
    .from(users)
    .where(eq(users.handle, handle.toLowerCase()))
    .limit(1);
  return Boolean(row);
}

/**
 * Create (or, for a self-deleted identity, reactivate) the account in one transaction:
 *   - `new` branch     → insert a fresh identity, then the user, then link them.
 *   - `self_deleted`   → reuse the existing identity (flip it back to active), new user.
 * Enforces the one-active-account-per-identity DB guard implicitly (unique partial index).
 */
export async function createAccount(input: {
  existingIdentityId: string | null;
  legalName: string;
  docType: string;
  docHash: string;
  provider: string;
  providerRef: string | null;
  handle: string;
  displayName: string | null;
  pinHash: string | null;
}): Promise<{ user: UserRow; identity: IdentityRow }> {
  return db.transaction(async (tx) => {
    let identity: IdentityRow;
    if (input.existingIdentityId) {
      const [row] = await tx
        .update(identities)
        .set({
          status: 'active',
          statusReason: null,
          deletedAt: null,
          suspendedAt: null,
          lastHandle: input.handle.toLowerCase(),
          updatedAt: sql`now()`,
        })
        .where(eq(identities.identityId, input.existingIdentityId))
        .returning();
      identity = row!;
    } else {
      const [row] = await tx
        .insert(identities)
        .values({
          legalName: input.legalName,
          docType: input.docType,
          docHash: input.docHash,
          provider: input.provider,
          providerRef: input.providerRef,
          status: 'active',
          lastHandle: input.handle.toLowerCase(),
        })
        .returning();
      identity = row!;
    }

    const [user] = await tx
      .insert(users)
      .values({
        identityId: identity.identityId,
        handle: input.handle.toLowerCase(),
        displayName: input.displayName,
        legalName: input.legalName,
        trustTier: 'verified',
        kycStatus: 'verified',
        kycProvider: input.provider,
        kycVerifiedAt: sql`now()`,
        onboardingComplete: true,
        accountStatus: 'active',
        isActive: true,
        pinHash: input.pinHash,
        pinSetAt: input.pinHash ? sql`now()` : null,
      })
      .returning();

    await tx
      .update(identities)
      .set({ currentUserId: user!.userId, updatedAt: sql`now()` })
      .where(eq(identities.identityId, identity.identityId));

    return { user: user!, identity };
  });
}
