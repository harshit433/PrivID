/**
 * Users service: self profile + settings, public profile view, directory search,
 * handle change, data export and self-service account deletion. All identity/KYC
 * fields are read-only here (owned by onboarding); this module owns the app profile.
 */
import { appError, enqueue, getStorageProvider, logger } from '@trustroute/core';
import crypto from 'crypto';
import * as repo from './users.repository';
import type { UserRow, ProfilePatch, SettingsPatch, DiscoverRow } from './users.repository';
import { persistVerificationScore } from '../../lib/trustScore';

const HANDLE_COOLDOWN_DAYS = 30;

const AVATAR_EXT: Record<string, string> = {
  'image/jpeg': 'jpg',
  'image/png': 'png',
  'image/webp': 'webp',
};

/** Full self view — everything the owner sees about their own account. */
export function selfView(u: UserRow) {
  return {
    userId: u.userId,
    identityId: u.identityId,
    handle: u.handle,
    displayName: u.displayName,
    legalName: u.legalName,
    avatarUrl: u.avatarUrl,
    email: u.email,
    bio: u.bio,
    profession: u.profession,
    organisation: u.organisation,
    businessInfo: u.businessInfo,
    address: u.address,
    languagePref: u.languagePref,
    trustTier: u.trustTier,
    trustScore: u.trustScore,
    statusText: u.statusText,
    statusEmoji: u.statusEmoji,
    lastSeenAt: u.lastSeenAt,
    onboardingComplete: u.onboardingComplete,
    accountStatus: u.accountStatus,
    phoneVerified: Boolean(u.phoneE164),
    pinSet: Boolean(u.pinHash),
    handleChangedAt: u.handleChangedAt,
    settings: settingsView(u),
  };
}

export function settingsView(u: UserRow) {
  return {
    discoveryMode: u.discoveryMode,
    discoveryContactBookMatching: u.discoveryContactBookMatching,
    discoveryShowTrustScore: u.discoveryShowTrustScore,
    notificationPrefs: u.notificationPrefs,
    userConsents: u.userConsents,
  };
}

/** Public view — what another user sees. Trust score is hidden if the owner opted out. */
export function publicView(u: UserRow) {
  return {
    userId: u.userId,
    handle: u.handle,
    displayName: u.displayName,
    avatarUrl: u.avatarUrl,
    trustTier: u.trustTier,
    trustScore: u.discoveryShowTrustScore ? u.trustScore : null,
    statusText: u.statusText,
    statusEmoji: u.statusEmoji,
    lastSeenAt: u.lastSeenAt,
  };
}

async function loadOr404(userId: string): Promise<UserRow> {
  const u = await repo.findById(userId);
  if (!u) throw appError('USER_INACTIVE');
  return u;
}

export async function getMe(userId: string) {
  return selfView(await loadOr404(userId));
}

export async function updateProfile(userId: string, patch: ProfilePatch) {
  return selfView(await repo.updateProfile(userId, patch));
}

export async function setAvatar(userId: string, avatarUrl: string | null) {
  const view = selfView(await repo.setAvatar(userId, avatarUrl));
  await persistVerificationScore(userId, 'profile_avatar').catch(() => {});
  await enqueue(
    'trust-recompute',
    { user_id: userId, reason: 'profile_avatar' },
    { jobId: `trust-${userId}-avatar` },
  ).catch(() => {});
  const fresh = await repo.findById(userId);
  return fresh ? selfView(fresh) : view;
}

/**
 * Legacy-compatible base64 avatar upload. Uses S3 when configured; otherwise stores a
 * data URL so onboarding/settings never fail for missing cloud storage.
 */
export async function uploadAvatarBase64(
  userId: string,
  imageBase64: string,
  contentType: string = 'image/jpeg',
) {
  const normalized = contentType.split(';')[0]!.trim().toLowerCase();
  const ext = AVATAR_EXT[normalized];
  if (!ext) throw appError('BAD_REQUEST', 'Unsupported image type. Use JPEG, PNG, or WebP.');

  const raw = imageBase64.replace(/^data:image\/\w+;base64,/, '');
  const buffer = Buffer.from(raw, 'base64');
  if (buffer.length < 100 || buffer.length > 8 * 1024 * 1024) {
    throw appError('BAD_REQUEST', 'Image must be between 100 bytes and 8 MB.');
  }

  let avatarUrl: string;
  const storage = getStorageProvider();
  const key = `media/avatar/${userId}/${crypto.randomUUID()}.${ext}`;
  if (storage.configured) {
    try {
      const put = await storage.putObject({ key, body: buffer, contentType: normalized });
      avatarUrl = put.publicUrl;
    } catch (err) {
      logger.warn('users', 'avatar S3 upload failed; using data URL', {
        userId,
        err: err instanceof Error ? err.message : String(err),
      });
      avatarUrl = `data:${normalized};base64,${buffer.toString('base64')}`;
    }
  } else {
    avatarUrl = `data:${normalized};base64,${buffer.toString('base64')}`;
  }

  return setAvatar(userId, avatarUrl);
}

export async function getSettings(userId: string) {
  return settingsView(await loadOr404(userId));
}

export async function updateSettings(userId: string, patch: SettingsPatch) {
  return settingsView(await repo.updateSettings(userId, patch));
}

export async function setStatus(userId: string, statusText: string | null, statusEmoji: string | null) {
  return selfView(await repo.updateProfile(userId, { statusText, statusEmoji }));
}

export async function changeHandle(userId: string, newHandle: string) {
  const me = await loadOr404(userId);
  const next = newHandle.toLowerCase();
  if (next === me.handle) return selfView(me);

  // Cooldown so handles aren't churned (and to bound propagation work).
  if (me.handleChangedAt) {
    const nextAllowed = me.handleChangedAt.getTime() + HANDLE_COOLDOWN_DAYS * 86_400_000;
    if (Date.now() < nextAllowed) {
      throw appError('CONFLICT', `You can change your handle again after ${new Date(nextAllowed).toDateString()}.`);
    }
  }
  const taken = await repo.findByHandle(next);
  if (taken) throw appError('HANDLE_TAKEN');

  return selfView(await repo.changeHandle(userId, next, me.handle));
}

export async function getPublicProfile(handle: string) {
  const u = await repo.findByHandle(handle);
  if (!u || u.accountStatus !== 'active') throw appError('HANDLE_NOT_FOUND');
  return publicView(u);
}

export async function discover(query: string, viewerId: string, limit: number): Promise<{ results: DiscoverRow[] }> {
  const trimmed = query.trim();
  if (trimmed.length < 2) return { results: [] };
  const results = await repo.searchDiscoverable(trimmed, viewerId, Math.min(limit, 50));
  return { results };
}

export async function requestDataExport(userId: string) {
  const me = await loadOr404(userId);
  const row = await repo.createDataExport(userId, me.email);
  // Hand off to the worker; best-effort so a queue outage never fails the request
  // (the data-export backstop scan re-enqueues rows stuck in `requested`).
  await enqueue('data-export', { request_id: row.requestId, user_id: userId }, { jobId: `data-export-${row.requestId}` }).catch(() => {});
  return { requestId: row.requestId, status: row.status, createdAt: row.createdAt };
}

export async function listDataExports(userId: string) {
  const rows = await repo.listDataExports(userId);
  return { requests: rows.map((r) => ({ requestId: r.requestId, status: r.status, createdAt: r.createdAt, downloadUrl: r.downloadUrl })) };
}

export async function deleteAccount(userId: string) {
  await loadOr404(userId);
  await repo.softDeleteAccount(userId);
  return { deleted: true };
}
