/**
 * Native chat service — Postgres-backed conversations + messages.
 * Permission gates reuse stream.ts computeChatGate / gateForSender.
 */
import crypto from 'crypto';
import { query, queryOne, withTransaction, getRedis } from '@trustroute/shared';
import type { ConnectionType } from '@trustroute/shared';
import { AppError } from '../middleware/errorHandler';
import {
  gateForSender,
  logMessage,
  orderedPair,
} from './stream';

export type ChatMessageType = 'text' | 'image' | 'video' | 'audio' | 'doc' | 'contact' | 'location' | 'system';

export interface ConversationListItem {
  conv_id: string;
  type: 'dm' | 'group';
  title: string;
  subtitle: string;
  avatar_url: string | null;
  other_user_id: string | null;
  handle: string | null;
  member_count: number;
  last_message_preview: string | null;
  last_message_at: string | null;
  unread_count: number;
  pinned: boolean;
  muted: boolean;
  trust_tier?: string;
  connection_type?: ConnectionType;
}

export interface ChatMessage {
  msg_id: string;
  conv_id: string;
  seq: number;
  sender_id: string;
  type: ChatMessageType;
  body: string | null;
  media_ref: string | null;
  reply_to: string | null;
  edited_at: string | null;
  deleted: boolean;
  created_at: string;
  status?: 'sending' | 'sent' | 'delivered' | 'read' | 'failed';
  reactions?: { emoji: string; user_id: string }[];
}

async function getUserLite(userId: string) {
  return queryOne<{
    user_id: string;
    handle: string;
    display_name: string | null;
    avatar_url: string | null;
    trust_tier: string;
  }>(
    `SELECT user_id, handle, display_name, avatar_url, trust_tier FROM users WHERE user_id = $1`,
    [userId],
  );
}

export async function getOrCreateDmConversation(userId: string, otherUserId: string): Promise<string> {
  const [low, high] = orderedPair(userId, otherUserId);
  const existing = await queryOne<{ conv_id: string }>(
    `SELECT c.conv_id FROM conversations c
     JOIN conversation_members m1 ON m1.conv_id = c.conv_id AND m1.user_id = $1
     JOIN conversation_members m2 ON m2.conv_id = c.conv_id AND m2.user_id = $2
     WHERE c.type = 'dm' LIMIT 1`,
    [low, high],
  );
  if (existing) return existing.conv_id;

  const channelCid = `messaging:${low}__${high}`;
  const convId = crypto.randomUUID();
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO conversations (conv_id, type, created_by, stream_channel_cid)
       VALUES ($1, 'dm', $2, $3)`,
      [convId, userId, channelCid],
    );
    await client.query(
      `INSERT INTO chat_channels (channel_cid, member_low, member_high)
       VALUES ($1, $2, $3) ON CONFLICT (member_low, member_high) DO NOTHING`,
      [channelCid, low, high],
    );
    await client.query(
      `INSERT INTO conversation_members (conv_id, user_id) VALUES ($1, $2), ($1, $3)`,
      [convId, low, high],
    );
  });
  return convId;
}

export async function listConversations(userId: string): Promise<ConversationListItem[]> {
  const rows = await query<{
    conv_id: string;
    type: 'dm' | 'group';
    title: string | null;
    avatar_ref: string | null;
    last_message_preview: string | null;
    last_message_at: Date | null;
    last_read_seq: string;
    last_seq: string;
    pinned: boolean;
    muted_until: Date | null;
    other_user_id: string | null;
    other_handle: string | null;
    other_name: string | null;
    other_avatar: string | null;
    other_tier: string | null;
    member_count: string;
  }>(
    `SELECT c.conv_id, c.type, c.title, c.avatar_ref, c.last_message_preview, c.last_message_at,
            cm.last_read_seq::text, c.last_seq::text, cm.pinned, cm.muted_until,
            ou.user_id AS other_user_id, ou.handle AS other_handle,
            ou.display_name AS other_name, ou.avatar_url AS other_avatar, ou.trust_tier AS other_tier,
            (SELECT COUNT(*)::text FROM conversation_members x WHERE x.conv_id = c.conv_id) AS member_count
     FROM conversation_members cm
     JOIN conversations c ON c.conv_id = cm.conv_id
     LEFT JOIN LATERAL (
       SELECT u.user_id, u.handle, u.display_name, u.avatar_url, u.trust_tier
       FROM conversation_members om
       JOIN users u ON u.user_id = om.user_id
       WHERE om.conv_id = c.conv_id AND om.user_id <> $1 AND c.type = 'dm'
       LIMIT 1
     ) ou ON TRUE
     WHERE cm.user_id = $1 AND cm.archived = FALSE
     ORDER BY cm.pinned DESC, c.last_message_at DESC NULLS LAST`,
    [userId],
  );

  const connRows = await query<{ contact_id: string; connection_type: ConnectionType }>(
    `SELECT contact_id, connection_type FROM connections WHERE owner_id = $1`,
    [userId],
  );
  const connMap = new Map(connRows.map((r) => [r.contact_id, r.connection_type]));

  return rows.map((r) => {
    const lastSeq = parseInt(r.last_seq, 10);
    const lastRead = parseInt(r.last_read_seq, 10);
    const isGroup = r.type === 'group';
    return {
      conv_id: r.conv_id,
      type: r.type,
      title: isGroup ? (r.title ?? 'Group') : (r.other_name ?? r.other_handle ?? 'Chat'),
      subtitle: isGroup ? `${r.member_count} members` : `@${r.other_handle ?? 'unknown'}`,
      avatar_url: isGroup ? r.avatar_ref : r.other_avatar,
      other_user_id: r.other_user_id,
      handle: r.other_handle,
      member_count: parseInt(r.member_count, 10),
      last_message_preview: r.last_message_preview,
      last_message_at: r.last_message_at ? new Date(r.last_message_at).toISOString() : null,
      unread_count: Math.max(0, lastSeq - lastRead),
      pinned: r.pinned,
      muted: r.muted_until ? new Date(r.muted_until) > new Date() : false,
      trust_tier: r.other_tier ?? undefined,
      connection_type: r.other_user_id ? connMap.get(r.other_user_id) : undefined,
    };
  });
}

export async function assertMember(convId: string, userId: string): Promise<void> {
  const m = await queryOne(`SELECT 1 FROM conversation_members WHERE conv_id = $1 AND user_id = $2`, [convId, userId]);
  if (!m) throw new AppError(403, 'FORBIDDEN', 'Not a member of this conversation.');
}

export async function listMessages(
  convId: string,
  userId: string,
  opts: { beforeSeq?: number; limit?: number },
): Promise<{ messages: ChatMessage[]; has_more: boolean }> {
  await assertMember(convId, userId);
  const limit = Math.min(opts.limit ?? 50, 100);
  const params: unknown[] = [convId];
  let where = 'm.conv_id = $1 AND m.deleted = FALSE';
  if (opts.beforeSeq) {
    params.push(opts.beforeSeq);
    where += ` AND m.seq < $${params.length}`;
  }
  params.push(limit + 1);

  const rows = await query<ChatMessage & { seq: string }>(
    `SELECT m.msg_id, m.conv_id, m.seq::int, m.sender_id, m.type, m.body, m.media_ref,
            m.reply_to, m.edited_at, m.deleted, m.created_at
     FROM messages m
     WHERE ${where}
     ORDER BY m.seq DESC
     LIMIT $${params.length}`,
    params,
  );

  const hasMore = rows.length > limit;
  const slice = hasMore ? rows.slice(0, limit) : rows;
  const msgIds = slice.map((r) => r.msg_id);
  const reactionRows = msgIds.length
    ? await query<{ msg_id: string; user_id: string; emoji: string }>(
        `SELECT msg_id, user_id, emoji FROM message_reactions WHERE msg_id = ANY($1::uuid[])`,
        [msgIds],
      )
    : [];
  const reactionsByMsg = new Map<string, { emoji: string; user_id: string }[]>();
  for (const r of reactionRows) {
    const list = reactionsByMsg.get(r.msg_id) ?? [];
    list.push({ emoji: r.emoji, user_id: r.user_id });
    reactionsByMsg.set(r.msg_id, list);
  }

  const messages = slice.reverse().map((r) => ({
    ...r,
    seq: Number(r.seq),
    created_at: new Date(r.created_at as unknown as string).toISOString(),
    edited_at: r.edited_at ? new Date(r.edited_at as unknown as string).toISOString() : null,
    reactions: reactionsByMsg.get(r.msg_id) ?? [],
  }));

  return { messages, has_more: hasMore };
}

async function resolveDmRecipient(convId: string, senderId: string): Promise<string | null> {
  const row = await queryOne<{ user_id: string }>(
    `SELECT user_id FROM conversation_members
     WHERE conv_id = $1 AND user_id <> $2 LIMIT 1`,
    [convId, senderId],
  );
  return row?.user_id ?? null;
}

export async function sendMessage(params: {
  convId: string;
  senderId: string;
  type: ChatMessageType;
  body?: string;
  mediaRef?: string;
  replyTo?: string;
  clientMsgId?: string;
}): Promise<ChatMessage> {
  const { convId, senderId, type, body, mediaRef, replyTo, clientMsgId } = params;
  await assertMember(convId, senderId);

  if (clientMsgId) {
    try {
      const redis = getRedis();
      const dedupKey = `chat-dedup:${senderId}:${clientMsgId}`;
      const existingMsgId = await redis.get(dedupKey);
      if (existingMsgId) {
        const existing = await queryOne<ChatMessage & { seq: number }>(
          `SELECT msg_id, conv_id, seq, sender_id, type, body, media_ref, reply_to, edited_at, deleted, created_at
           FROM messages WHERE msg_id = $1`,
          [existingMsgId],
        );
        if (existing) {
          return {
            ...existing,
            created_at: new Date(existing.created_at as unknown as string).toISOString(),
            edited_at: existing.edited_at ? new Date(existing.edited_at as unknown as string).toISOString() : null,
            status: 'sent',
          };
        }
      }
    } catch { /* redis down — proceed */ }
  }

  const conv = await queryOne<{ type: string; stream_channel_cid: string | null }>(
    `SELECT type, stream_channel_cid FROM conversations WHERE conv_id = $1`,
    [convId],
  );
  if (!conv) throw new AppError(404, 'NOT_FOUND', 'Conversation not found.');

  if (conv.type === 'dm') {
    const recipientId = await resolveDmRecipient(convId, senderId);
    if (!recipientId) throw new AppError(400, 'INVALID_CONVERSATION', 'Invalid DM.');
    const gate = await gateForSender(senderId, recipientId);
    if (!gate.can_send) {
      throw new AppError(403, gate.code ?? 'CHAT_NOT_ALLOWED', gate.reason ?? 'Cannot send message.');
    }
  }

  const msg = await withTransaction(async (client) => {
    const seqRow = await client.query(
      `UPDATE conversations SET last_seq = last_seq + 1, updated_at = NOW()
       WHERE conv_id = $1 RETURNING last_seq`,
      [convId],
    );
    const seq = parseInt(seqRow.rows[0].last_seq as string, 10);
    const msgId = crypto.randomUUID();
    const preview = body?.slice(0, 120) ?? (mediaRef ? `[${type}]` : '');

    await client.query(
      `INSERT INTO messages (msg_id, conv_id, seq, sender_id, type, body, media_ref, reply_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [msgId, convId, seq, senderId, type, body ?? null, mediaRef ?? null, replyTo ?? null],
    );
    await client.query(
      `UPDATE conversations SET last_message_preview = $2, last_message_at = NOW() WHERE conv_id = $1`,
      [convId, preview],
    );

    return { msgId, seq, preview };
  });

  // Audit log for DM caps (reuse chat_message_log)
  if (conv.type === 'dm') {
    const recipientId = await resolveDmRecipient(convId, senderId);
    if (recipientId && conv.stream_channel_cid) {
      await logMessage(msg.msgId, conv.stream_channel_cid, senderId, recipientId);
    }
  }

  if (params.clientMsgId) {
    try {
      const redis = getRedis();
      await redis.setex(`chat-dedup:${senderId}:${params.clientMsgId}`, 300, msg.msgId);
    } catch { /* ignore */ }
  }

  return {
    msg_id: msg.msgId,
    conv_id: convId,
    seq: msg.seq,
    sender_id: senderId,
    type,
    body: body ?? null,
    media_ref: mediaRef ?? null,
    reply_to: replyTo ?? null,
    edited_at: null,
    deleted: false,
    created_at: new Date().toISOString(),
    status: 'sent',
  };
}

export async function markRead(convId: string, userId: string, upToSeq: number): Promise<void> {
  await query(
    `UPDATE conversation_members SET last_read_seq = GREATEST(last_read_seq, $3)
     WHERE conv_id = $1 AND user_id = $2`,
    [convId, userId, upToSeq],
  );
}

export async function setMuted(convId: string, userId: string, until: Date | null): Promise<void> {
  await query(
    `UPDATE conversation_members SET muted_until = $3 WHERE conv_id = $1 AND user_id = $2`,
    [convId, userId, until],
  );
}

export async function setPinned(convId: string, userId: string, pinned: boolean): Promise<void> {
  await query(
    `UPDATE conversation_members SET pinned = $3 WHERE conv_id = $1 AND user_id = $2`,
    [convId, userId, pinned],
  );
}

export async function getConversationContext(convId: string, userId: string) {
  await assertMember(convId, userId);
  const conv = await queryOne<{ type: string; group_id: string | null }>(
    `SELECT type, group_id FROM conversations WHERE conv_id = $1`,
    [convId],
  );
  if (conv?.type === 'dm') {
    const other = await queryOne<{ user_id: string }>(
      `SELECT user_id FROM conversation_members WHERE conv_id = $1 AND user_id <> $2 LIMIT 1`,
      [convId, userId],
    );
    if (other) {
      const gate = await gateForSender(userId, other.user_id);
      return { gate, other_user_id: other.user_id };
    }
  }
  return { gate: null, other_user_id: null };
}

export async function addReaction(msgId: string, userId: string, emoji: string): Promise<void> {
  const msg = await queryOne<{ conv_id: string }>(`SELECT conv_id FROM messages WHERE msg_id = $1 AND deleted = FALSE`, [msgId]);
  if (!msg) throw new AppError(404, 'NOT_FOUND', 'Message not found.');
  await assertMember(msg.conv_id, userId);
  await query(
    `INSERT INTO message_reactions (msg_id, user_id, emoji) VALUES ($1, $2, $3)
     ON CONFLICT (msg_id, user_id) DO UPDATE SET emoji = EXCLUDED.emoji`,
    [msgId, userId, emoji.slice(0, 16)],
  );
}

export async function removeReaction(msgId: string, userId: string): Promise<void> {
  const msg = await queryOne<{ conv_id: string }>(`SELECT conv_id FROM messages WHERE msg_id = $1`, [msgId]);
  if (!msg) throw new AppError(404, 'NOT_FOUND', 'Message not found.');
  await assertMember(msg.conv_id, userId);
  await query(`DELETE FROM message_reactions WHERE msg_id = $1 AND user_id = $2`, [msgId, userId]);
}

export async function softDeleteMessage(msgId: string, userId: string, forEveryone: boolean): Promise<void> {
  const msg = await queryOne<{ conv_id: string; sender_id: string; created_at: Date }>(
    `SELECT conv_id, sender_id, created_at FROM messages WHERE msg_id = $1 AND deleted = FALSE`,
    [msgId],
  );
  if (!msg) throw new AppError(404, 'NOT_FOUND', 'Message not found.');
  await assertMember(msg.conv_id, userId);
  if (forEveryone) {
    if (msg.sender_id !== userId) throw new AppError(403, 'FORBIDDEN', 'Cannot delete for everyone.');
    const ageMs = Date.now() - new Date(msg.created_at).getTime();
    if (ageMs > 3600_000) throw new AppError(403, 'FORBIDDEN', 'Delete for everyone window expired.');
  }
  await query(`UPDATE messages SET deleted = TRUE WHERE msg_id = $1`, [msgId]);
}

export async function clearConversationForUser(convId: string, userId: string): Promise<number> {
  await assertMember(convId, userId);
  const rows = await query<{ msg_id: string }>(
    `UPDATE messages SET deleted = TRUE
      WHERE conv_id = $1 AND deleted = FALSE
      RETURNING msg_id`,
    [convId],
  );
  return rows.length;
}

export type ConversationMediaItem = {
  msg_id: string;
  type: string;
  media_ref: string;
  body: string | null;
  created_at: string;
};

export async function listConversationMedia(
  convId: string,
  userId: string,
  kind?: 'image' | 'video' | 'doc',
): Promise<ConversationMediaItem[]> {
  await assertMember(convId, userId);
  const types =
    kind === 'image' ? ['image']
    : kind === 'video' ? ['video']
    : kind === 'doc' ? ['doc', 'audio']
    : ['image', 'video', 'doc', 'audio'];
  return query<ConversationMediaItem>(
    `SELECT msg_id, type, media_ref, body, created_at
       FROM messages
      WHERE conv_id = $1
        AND deleted = FALSE
        AND media_ref IS NOT NULL
        AND type = ANY($2::text[])
      ORDER BY created_at DESC
      LIMIT 120`,
    [convId, types],
  );
}

export async function ensureNativeGroupConversation(
  groupId: string,
  name: string,
  creatorId: string,
  memberIds: string[],
  channelCid: string,
  avatarUrl?: string | null,
): Promise<string> {
  const existing = await queryOne<{ conv_id: string }>(
    `SELECT conv_id FROM conversations WHERE group_id = $1`,
    [groupId],
  );
  if (existing) return existing.conv_id;

  const convId = groupId;
  await withTransaction(async (client) => {
    await client.query(
      `INSERT INTO conversations (conv_id, type, created_by, title, avatar_ref, group_id, stream_channel_cid)
       VALUES ($1, 'group', $2, $3, $4, $5, $6)
       ON CONFLICT (group_id) DO NOTHING`,
      [convId, creatorId, name, avatarUrl ?? null, groupId, channelCid],
    );
    for (const uid of memberIds) {
      const role = uid === creatorId ? 'admin' : 'member';
      await client.query(
        `INSERT INTO conversation_members (conv_id, user_id, role)
         VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`,
        [convId, uid, role],
      );
    }
  });
  return convId;
}

export { getOrCreateDmConversation as openDmWithUser };
