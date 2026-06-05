/**
 * stream.ts — Stream Chat server integration.
 *
 * Responsibilities:
 *   - Hold the server-side StreamChat singleton (API key + secret).
 *   - Issue per-user chat tokens (every app launch).
 *   - Provision 1:1 "distinct" messaging channels between two PrivID users.
 *   - Mirror PrivID's connection model into Stream: blocking a user bans them
 *     from the shared channel; the channel carries the live connection_type.
 *   - Compute the server-authoritative message-permission gate that backs both
 *     the inbox UI and the "before message send" webhook.
 *
 * Connection type is shared with calls — there is no separate chat permission.
 * The relationship that governs whether you can CALL someone also governs
 * whether you can MESSAGE them.
 *
 * Environment:
 *   STREAM_API_KEY      Stream app key
 *   STREAM_API_SECRET   Stream app secret (server only — never sent to client)
 */

import { StreamChat } from 'stream-chat';
import { query, queryOne } from '@trustroute/shared';
import type { ConnectionType } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';

// ─── Permission constants (deliberately more relaxed than calls) ──────────────
// Unknown senders get a small lifetime intro allowance per recipient; the
// recipient then chooses to continue (trusted/temporary) or block.
export const CHAT_UNKNOWN_TOTAL_LIMIT = 3;
// Temporary contacts may message freely within their access window, capped by a
// generous daily limit (far higher than the call daily limit).
export const CHAT_TEMPORARY_DAILY_LIMIT = 50;

// ─── Singleton ────────────────────────────────────────────────────────────────

let client: StreamChat | null = null;

export function isStreamConfigured(): boolean {
  return !!(process.env.STREAM_API_KEY && process.env.STREAM_API_SECRET);
}

export function getStreamClient(): StreamChat {
  if (!client) {
    const apiKey = process.env.STREAM_API_KEY;
    const apiSecret = process.env.STREAM_API_SECRET;
    if (!apiKey || !apiSecret) {
      throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Chat is not configured on the server.');
    }
    client = StreamChat.getInstance(apiKey, apiSecret);
  }
  return client;
}

export function getStreamApiKey(): string {
  const apiKey = process.env.STREAM_API_KEY;
  if (!apiKey) throw new AppError(503, 'STREAM_NOT_CONFIGURED', 'Chat is not configured on the server.');
  return apiKey;
}

// ─── User + token ──────────────────────────────────────────────────────────────

export interface StreamUserInfo {
  user_id: string;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
}

/** Upsert a PrivID user into Stream so they can participate in chat. */
export async function upsertStreamUser(u: StreamUserInfo): Promise<void> {
  const sc = getStreamClient();
  await sc.upsertUser({
    id: u.user_id,
    name: u.display_name ?? u.handle,
    handle: u.handle,
    ...(u.avatar_url ? { image: u.avatar_url } : {}),
  } as any);
}

/** Create a chat token for the given user (called on every app launch). */
export function createUserToken(userId: string): string {
  return getStreamClient().createToken(userId);
}

// ─── Channel helpers ────────────────────────────────────────────────────────────

/** Deterministic, stable member ordering for a 1:1 pair. */
export function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

export interface DirectChannelResult {
  cid: string;
  id: string;
}

/**
 * Get-or-create the distinct 1:1 messaging channel between two users.
 * Both users are added as members; the channel carries the *recipient-relative*
 * connection types so clients can render the relationship without extra calls.
 */
export async function getOrCreateDirectChannel(
  selfId: string,
  otherId: string,
): Promise<DirectChannelResult> {
  const sc = getStreamClient();
  const [low, high] = orderedPair(selfId, otherId);

  const channel = sc.channel('messaging', {
    members: [selfId, otherId],
    created_by_id: selfId,
  } as any);

  await channel.create();

  const cid = channel.cid ?? `messaging:${channel.id}`;
  const id = channel.id ?? cid.split(':')[1];

  await query(
    `INSERT INTO chat_channels (channel_cid, member_low, member_high)
     VALUES ($1, $2, $3)
     ON CONFLICT (member_low, member_high) DO UPDATE SET channel_cid = EXCLUDED.channel_cid`,
    [cid, low, high],
  );

  return { cid, id };
}

/**
 * Mirror a connection-type change onto the shared channel and Stream's ban list.
 * Blocking bans the *contact* (so they cannot send to us); any non-blocked type
 * lifts the ban. Safe to call even if the channel does not exist yet.
 */
export async function syncConnectionToStream(
  ownerId: string,
  contactId: string,
  connectionType: ConnectionType,
): Promise<void> {
  if (!isStreamConfigured()) return;
  try {
    const sc = getStreamClient();
    const [low, high] = orderedPair(ownerId, contactId);

    const mapping = await queryOne<{ channel_cid: string }>(
      `SELECT channel_cid FROM chat_channels WHERE member_low = $1 AND member_high = $2`,
      [low, high],
    );
    if (!mapping) return; // no channel yet — nothing to mirror

    const channel = sc.channel('messaging', mapping.channel_cid.split(':')[1]);

    if (connectionType === 'blocked') {
      // Ban the contact from this channel — they can no longer message the owner.
      await channel.banUser(contactId, { banned_by_id: ownerId, reason: 'blocked_by_user' });
    } else {
      await channel.unbanUser(contactId).catch(() => { /* not banned — fine */ });
    }
  } catch (err: any) {
    console.warn('[stream] syncConnectionToStream failed:', err?.message);
  }
}

// ─── Message accounting ─────────────────────────────────────────────────────────

/** Total messages a sender has ever sent to a recipient (intro-cap counter). */
export async function countMessagesSent(senderId: string, recipientId: string): Promise<number> {
  const [row] = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM chat_message_log
     WHERE sender_id = $1 AND recipient_id = $2`,
    [senderId, recipientId],
  );
  return parseInt(row?.count ?? '0', 10);
}

/** Messages a sender has sent to a recipient since midnight (daily-cap counter). */
export async function countMessagesSentToday(senderId: string, recipientId: string): Promise<number> {
  const [row] = await query<{ count: string }>(
    `SELECT COUNT(*)::text AS count FROM chat_message_log
     WHERE sender_id = $1 AND recipient_id = $2 AND created_at >= CURRENT_DATE`,
    [senderId, recipientId],
  );
  return parseInt(row?.count ?? '0', 10);
}

export async function logMessage(
  messageId: string,
  channelCid: string,
  senderId: string,
  recipientId: string,
): Promise<void> {
  await query(
    `INSERT INTO chat_message_log (message_id, channel_cid, sender_id, recipient_id)
     VALUES ($1, $2, $3, $4)
     ON CONFLICT (message_id) DO NOTHING`,
    [messageId, channelCid, senderId, recipientId],
  );
}

// ─── Permission gate (shared by webhook + context endpoint) ──────────────────────

export type ChatGateMode =
  | 'unlimited'
  | 'intro_capped'
  | 'daily_capped'
  | 'blocked'
  | 'expired';

export interface ChatGate {
  can_send: boolean;
  mode: ChatGateMode;
  /** How the *recipient* classifies the *sender* — this governs sending. */
  connection_type: ConnectionType;
  limit: number | null;     // intro/daily allowance, or null when unlimited
  used: number;
  remaining: number | null; // null when unlimited
  code?: string;
  reason?: string;
}

/**
 * Compute whether `senderId` may send to `recipientId`, based on how the
 * recipient classifies the sender. Pure-ish: callers pass pre-fetched counts.
 */
export function computeChatGate(params: {
  connectionType: ConnectionType;
  temporaryExpiresAt: Date | string | null;
  totalUsed: number;
  todayUsed: number;
}): ChatGate {
  const { connectionType, temporaryExpiresAt, totalUsed, todayUsed } = params;

  if (connectionType === 'blocked') {
    return {
      can_send: false, mode: 'blocked', connection_type: connectionType,
      limit: 0, used: totalUsed, remaining: 0,
      code: 'CHAT_BLOCKED', reason: 'You can no longer message this person.',
    };
  }

  if (connectionType === 'trusted') {
    return {
      can_send: true, mode: 'unlimited', connection_type: connectionType,
      limit: null, used: totalUsed, remaining: null,
    };
  }

  if (connectionType === 'temporary') {
    if (temporaryExpiresAt && new Date() > new Date(temporaryExpiresAt)) {
      return {
        can_send: false, mode: 'expired', connection_type: connectionType,
        limit: CHAT_TEMPORARY_DAILY_LIMIT, used: todayUsed, remaining: 0,
        code: 'CHAT_TEMPORARY_EXPIRED', reason: 'Your temporary access to this person has expired.',
      };
    }
    const remaining = Math.max(0, CHAT_TEMPORARY_DAILY_LIMIT - todayUsed);
    return {
      can_send: remaining > 0, mode: 'daily_capped', connection_type: connectionType,
      limit: CHAT_TEMPORARY_DAILY_LIMIT, used: todayUsed, remaining,
      ...(remaining === 0 ? { code: 'CHAT_DAILY_LIMIT', reason: 'Daily message limit reached. Try again tomorrow.' } : {}),
    };
  }

  // unknown — small lifetime intro allowance until the recipient upgrades/blocks
  const remaining = Math.max(0, CHAT_UNKNOWN_TOTAL_LIMIT - totalUsed);
  return {
    can_send: remaining > 0, mode: 'intro_capped', connection_type: connectionType,
    limit: CHAT_UNKNOWN_TOTAL_LIMIT, used: totalUsed, remaining,
    ...(remaining === 0
      ? { code: 'CHAT_INTRO_LIMIT', reason: `You've used all ${CHAT_UNKNOWN_TOTAL_LIMIT} intro messages. Wait for them to accept you.` }
      : {}),
  };
}

/** Look up how `recipientId` classifies `senderId` (defaults to unknown). */
export async function getConnectionTypeFor(
  recipientId: string,
  senderId: string,
): Promise<{ connection_type: ConnectionType; temporary_expires_at: Date | null }> {
  const conn = await queryOne<{ connection_type: ConnectionType; temporary_expires_at: Date | null }>(
    `SELECT connection_type, temporary_expires_at FROM connections
     WHERE owner_id = $1 AND contact_id = $2`,
    [recipientId, senderId],
  );
  return {
    connection_type: conn?.connection_type ?? 'unknown',
    temporary_expires_at: conn?.temporary_expires_at ?? null,
  };
}

// ─── Group channel helpers ────────────────────────────────────────────────────

/** Create a named group channel in Stream with the given members. */
export async function createGroupChannel(
  channelId: string,
  name: string,
  creatorId: string,
  memberIds: string[],
  avatarUrl?: string | null,
): Promise<void> {
  const sc = getStreamClient();
  const allMembers = [...new Set([creatorId, ...memberIds])];
  const ch = sc.channel('messaging', channelId, {
    created_by_id: creatorId,
    members: allMembers,
    ...({ name, is_group: true, ...(avatarUrl ? { image: avatarUrl } : {}) } as any),
  });
  await ch.create();
  // Grant admin role to creator
  await ch.addMembers([{ user_id: creatorId, channel_role: 'channel_admin' as any }]);
}

/** Add one user to an existing group channel (member role). */
export async function addGroupMember(channelId: string, userId: string, asAdmin = false): Promise<void> {
  const sc = getStreamClient();
  const ch = sc.channel('messaging', channelId);
  await ch.addMembers([{ user_id: userId, channel_role: (asAdmin ? 'channel_admin' : 'channel_member') as any }]);
}

/** Remove a user from a group channel. */
export async function removeGroupMember(channelId: string, userId: string): Promise<void> {
  const sc = getStreamClient();
  const ch = sc.channel('messaging', channelId);
  await ch.removeMembers([userId]);
}

/** Update group name and/or image in Stream. */
export async function updateGroupChannel(
  channelId: string,
  updates: { name?: string; image?: string | null },
): Promise<void> {
  const sc = getStreamClient();
  const ch = sc.channel('messaging', channelId);
  const partial: Record<string, unknown> = {};
  if (updates.name !== undefined) partial.name = updates.name;
  if (updates.image !== undefined) partial.image = updates.image ?? null;
  if (Object.keys(partial).length > 0) await ch.update(partial as any);
}

/** Hard-delete a group channel from Stream (removes all messages). */
export async function deleteGroupChannel(channelId: string): Promise<void> {
  const sc = getStreamClient();
  const ch = sc.channel('messaging', channelId);
  await ch.delete({ hard_delete: true } as any);
}

/** Delete a message as a server-side admin (any message, not just the sender's). */
export async function deleteMessageAsAdmin(messageId: string): Promise<void> {
  const sc = getStreamClient();
  await sc.deleteMessage(messageId, true);
}

/** End-to-end gate: fetch connection + counts, then compute. */
export async function gateForSender(senderId: string, recipientId: string): Promise<ChatGate> {
  const [{ connection_type, temporary_expires_at }, totalUsed, todayUsed] = await Promise.all([
    getConnectionTypeFor(recipientId, senderId),
    countMessagesSent(senderId, recipientId),
    countMessagesSentToday(senderId, recipientId),
  ]);
  return computeChatGate({
    connectionType: connection_type,
    temporaryExpiresAt: temporary_expires_at,
    totalUsed,
    todayUsed,
  });
}
