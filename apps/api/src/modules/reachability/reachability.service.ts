/**
 * Reachability service: manage inbound-call channels and shareable contact links, and
 * resolve a scanned share token into the owner's public profile (recording the scan).
 */
import { appError } from '@trustroute/core';
import * as repo from './reachability.repository';
import type { ChannelRow, ShareRow } from './reachability.repository';

const hoursFromNow = (h?: number | null): Date | null => (h ? new Date(Date.now() + h * 3_600_000) : null);

function channelView(c: ChannelRow) {
  return {
    channelId: c.channelId,
    token: c.token,
    label: c.label,
    status: c.status,
    dailyLimit: c.dailyLimit,
    totalLimit: c.totalLimit,
    useCount: c.useCount,
    expiresAt: c.expiresAt,
    createdAt: c.createdAt,
  };
}

function shareView(s: ShareRow) {
  return {
    shareId: s.shareId,
    token: s.token,
    type: s.type,
    label: s.label,
    maxUses: s.maxUses,
    uses: s.uses,
    active: s.active,
    expiresAt: s.expiresAt,
    createdAt: s.createdAt,
  };
}

// ── Channels ──────────────────────────────────────────────────────────────────

export async function createChannel(
  ownerId: string,
  input: { label?: string; dailyLimit?: number; totalLimit?: number; expiresInHours?: number },
) {
  const c = await repo.createChannel(ownerId, {
    label: input.label ?? null,
    dailyLimit: input.dailyLimit,
    totalLimit: input.totalLimit ?? null,
    expiresAt: hoursFromNow(input.expiresInHours),
  });
  return channelView(c);
}

export async function listChannels(ownerId: string) {
  return { channels: (await repo.listChannels(ownerId)).map(channelView) };
}

export async function revokeChannel(ownerId: string, channelId: string) {
  if (!(await repo.revokeChannel(ownerId, channelId))) throw appError('NOT_FOUND', 'Channel not found.');
  return { revoked: true };
}

// ── Shares ────────────────────────────────────────────────────────────────────

export async function createShare(
  ownerId: string,
  input: { type: 'permanent' | 'disposable'; label?: string; expiresInHours?: number; maxUses?: number },
) {
  const s = await repo.createShare(ownerId, {
    type: input.type,
    label: input.label ?? null,
    expiresAt: hoursFromNow(input.expiresInHours),
    maxUses: input.maxUses ?? null,
  });
  return shareView(s);
}

export async function listShares(ownerId: string) {
  return { shares: (await repo.listShares(ownerId)).map(shareView) };
}

export async function revokeShare(ownerId: string, shareId: string) {
  if (!(await repo.revokeShare(ownerId, shareId))) throw appError('NOT_FOUND', 'Share not found.');
  return { revoked: true };
}

/**
 * Resolve a scanned/opened share token. Records the scan (spending a disposable link)
 * and returns the owner's public card so the scanner can add them as a connection.
 */
export async function resolveShare(token: string, scannerId: string, deviceHash?: string) {
  const found = await repo.findActiveShareByToken(token);
  if (!found) throw appError('NOT_FOUND', 'This link is invalid or has expired.');
  const spent = await repo.recordScan(found.share.shareId, scannerId, deviceHash ?? null);
  if (!spent) throw appError('CONFLICT', 'This link has already been used.');
  return {
    shareId: found.share.shareId,
    owner: {
      userId: found.owner.userId,
      handle: found.owner.handle,
      displayName: found.owner.displayName,
      avatarUrl: found.owner.avatarUrl,
      trustTier: found.owner.trustTier,
      trustScore: found.owner.discoveryShowTrustScore ? found.owner.trustScore : null,
    },
  };
}
