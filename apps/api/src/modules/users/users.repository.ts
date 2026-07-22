/**
 * Users repository — the only place that reads/writes the users table. This file
 * carries the auth + presence slice needed in P2; profile/settings queries are added
 * in P3. Rows are Drizzle-native camelCase.
 */
import bcrypt from 'bcryptjs';
import {
  db,
  users,
  identities,
  dataExportRequests,
  handlePropagationJobs,
  eq,
  and,
  ne,
  or,
  sql,
  ilike,
  desc,
  acquireGate,
  keys,
  TTL,
} from '@trustroute/core';
import type { AuthAccountRow } from '@trustroute/core';

/** Minimal projection the auth guard needs to decide session validity. */
export async function findAuthAccount(userId: string): Promise<AuthAccountRow | null> {
  const [row] = await db
    .select({ userId: users.userId, accountStatus: users.accountStatus, isActive: users.isActive })
    .from(users)
    .where(eq(users.userId, userId))
    .limit(1);
  return row ?? null;
}

export type UserRow = typeof users.$inferSelect;

export async function findById(userId: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.userId, userId)).limit(1);
  return row ?? null;
}

export async function findByHandle(handle: string): Promise<UserRow | null> {
  const [row] = await db.select().from(users).where(eq(users.handle, handle.toLowerCase())).limit(1);
  return row ?? null;
}

// ── PIN state (auth co-owns these users columns) ─────────────────────────────
const PIN_MAX_ATTEMPTS = 5;
const PIN_LOCK_MINUTES = 15;
const BCRYPT_ROUNDS = 10;

/** Hash a 6-digit PIN for storage. The plaintext PIN never leaves the request. */
export function hashPin(pin: string): Promise<string> {
  return bcrypt.hash(pin, BCRYPT_ROUNDS);
}

export async function setPin(userId: string, pinHash: string): Promise<void> {
  await db
    .update(users)
    .set({ pinHash, pinSetAt: sql`now()`, pinFailedAttempts: 0, pinLockedUntil: null })
    .where(eq(users.userId, userId));
}

export async function clearPinFailures(userId: string): Promise<void> {
  await db.update(users).set({ pinFailedAttempts: 0, pinLockedUntil: null }).where(eq(users.userId, userId));
}

/** Increment failed attempts and lock after the threshold. Returns the new lock (if any). */
export async function recordPinFailure(userId: string): Promise<{ lockedUntil: Date | null }> {
  const [row] = await db
    .update(users)
    .set({
      pinFailedAttempts: sql`${users.pinFailedAttempts} + 1`,
      pinLockedUntil: sql`CASE WHEN ${users.pinFailedAttempts} + 1 >= ${PIN_MAX_ATTEMPTS}
        THEN now() + (${PIN_LOCK_MINUTES} || ' minutes')::interval ELSE ${users.pinLockedUntil} END`,
    })
    .where(eq(users.userId, userId))
    .returning({ lockedUntil: users.pinLockedUntil });
  return { lockedUntil: row?.lockedUntil ?? null };
}

/**
 * Fire-and-forget presence heartbeat: at most one last_seen write / 2 min / user,
 * gated by a Redis NX key. Never blocks the request; swallows all errors.
 */
export function touchPresence(userId: string): void {
  setImmediate(async () => {
    try {
      if (await acquireGate(keys.presence(userId), TTL.presence)) {
        await db.update(users).set({ lastSeenAt: sql`now()` }).where(eq(users.userId, userId));
      }
    } catch {
      // presence is best-effort
    }
  });
}

// ── Profile ──────────────────────────────────────────────────────────────────

/** Editable profile columns (subset of users the owner may PATCH). */
export interface ProfilePatch {
  displayName?: string | null;
  bio?: string | null;
  profession?: string | null;
  organisation?: string | null;
  businessInfo?: string | null;
  address?: string | null;
  email?: string | null;
  languagePref?: string;
  statusText?: string | null;
  statusEmoji?: string | null;
}

export async function updateProfile(userId: string, patch: ProfilePatch): Promise<UserRow> {
  const [row] = await db
    .update(users)
    .set({ ...patch, updatedAt: sql`now()` })
    .where(eq(users.userId, userId))
    .returning();
  return row!;
}

export async function setAvatar(userId: string, avatarUrl: string | null): Promise<UserRow> {
  const [row] = await db
    .update(users)
    .set({ avatarUrl, updatedAt: sql`now()` })
    .where(eq(users.userId, userId))
    .returning();
  return row!;
}

// ── Settings (discovery + notification prefs + consents) ─────────────────────

export interface SettingsPatch {
  discoveryMode?: 'public' | 'private';
  discoveryContactBookMatching?: boolean;
  discoveryShowTrustScore?: boolean;
  notificationPrefs?: Record<string, unknown>;
  userConsents?: Record<string, unknown>;
}

/** Shallow-merge the jsonb pref/consent blobs; replace the scalar discovery flags. */
export async function updateSettings(userId: string, patch: SettingsPatch): Promise<UserRow> {
  const set: Record<string, unknown> = { updatedAt: sql`now()` };
  if (patch.discoveryMode !== undefined) set.discoveryMode = patch.discoveryMode;
  if (patch.discoveryContactBookMatching !== undefined)
    set.discoveryContactBookMatching = patch.discoveryContactBookMatching;
  if (patch.discoveryShowTrustScore !== undefined) set.discoveryShowTrustScore = patch.discoveryShowTrustScore;
  if (patch.notificationPrefs !== undefined)
    set.notificationPrefs = sql`${users.notificationPrefs} || ${JSON.stringify(patch.notificationPrefs)}::jsonb`;
  if (patch.userConsents !== undefined)
    set.userConsents = sql`${users.userConsents} || ${JSON.stringify(patch.userConsents)}::jsonb`;
  const [row] = await db.update(users).set(set).where(eq(users.userId, userId)).returning();
  return row!;
}

// ── Handle change (with async propagation job for external systems) ──────────

export async function changeHandle(userId: string, newHandle: string, oldHandle: string): Promise<UserRow> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .update(users)
      .set({ handle: newHandle.toLowerCase(), handleChangedAt: sql`now()`, updatedAt: sql`now()` })
      .where(eq(users.userId, userId))
      .returning();
    await tx
      .update(identities)
      .set({ lastHandle: newHandle.toLowerCase(), updatedAt: sql`now()` })
      .where(eq(identities.currentUserId, userId));
    // Worker reconciles denormalized/external copies (e.g. Stream username).
    await tx.insert(handlePropagationJobs).values({ userId, oldHandle, newHandle: newHandle.toLowerCase() });
    return row!;
  });
}

// ── Discovery ────────────────────────────────────────────────────────────────

export interface DiscoverRow {
  userId: string;
  handle: string;
  displayName: string | null;
  avatarUrl: string | null;
  trustTier: UserRow['trustTier'];
  trustScore: number | null;
}

/**
 * Public-directory search: publicly-discoverable, active accounts whose handle or
 * display name matches. `trustScore` is nulled out for users who hide it. Excludes self.
 */
export async function searchDiscoverable(query: string, excludeUserId: string, limit: number): Promise<DiscoverRow[]> {
  const q = `%${query}%`;
  return db
    .select({
      userId: users.userId,
      handle: users.handle,
      displayName: users.displayName,
      avatarUrl: users.avatarUrl,
      trustTier: users.trustTier,
      trustScore: sql<number | null>`CASE WHEN ${users.discoveryShowTrustScore} THEN ${users.trustScore} ELSE NULL END`,
    })
    .from(users)
    .where(
      and(
        ne(users.userId, excludeUserId),
        eq(users.discoveryMode, 'public'),
        eq(users.accountStatus, 'active'),
        or(ilike(users.handle, q), ilike(users.displayName, q)),
      ),
    )
    .orderBy(desc(users.trustScore))
    .limit(limit);
}

// ── Account deletion (self-service) ──────────────────────────────────────────

/**
 * Soft-delete: the account becomes `self_deleted` (recreatable via onboarding) and the
 * identity is released so the person can re-onboard. A purge is scheduled for hard
 * cleanup by the worker. Refresh tokens are dropped so existing sessions die.
 */
export async function softDeleteAccount(userId: string, purgeAfterDays = 30): Promise<void> {
  await db.transaction(async (tx) => {
    const [user] = await tx.select().from(users).where(eq(users.userId, userId)).limit(1);
    if (!user) return;

    const previousHandle = user.handle.toLowerCase();
    const tombstoneId = `deleted_${user.userId}`;

    await tx
      .update(users)
      .set({
        accountStatus: 'self_deleted',
        isActive: false,
        handle: tombstoneId,
        displayName: 'Deleted Account',
        deletedAt: sql`now()`,
        accountStatusUpdatedAt: sql`now()`,
        purgeScheduledAt: sql`now() + (${purgeAfterDays} || ' days')::interval`,
        updatedAt: sql`now()`,
      })
      .where(eq(users.userId, userId));

    if (user.identityId) {
      await tx
        .update(identities)
        .set({
          status: 'self_deleted',
          currentUserId: null,
          lastHandle: previousHandle,
          deletedAt: sql`now()`,
          updatedAt: sql`now()`,
        })
        .where(eq(identities.identityId, user.identityId));
    }
  });
}

// ── Data export (GDPR-style; fulfilled asynchronously by the worker) ─────────

export async function createDataExport(userId: string, email: string | null) {
  const [row] = await db.insert(dataExportRequests).values({ userId, email }).returning();
  return row!;
}

export async function listDataExports(userId: string) {
  return db
    .select()
    .from(dataExportRequests)
    .where(eq(dataExportRequests.userId, userId))
    .orderBy(desc(dataExportRequests.createdAt))
    .limit(20);
}
