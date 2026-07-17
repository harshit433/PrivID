/**
 * Chat is Stream-only. We keep just the server-authoritative bits:
 *  - chat_channels: 1:1 channel registry (sorted member pair → deterministic cid)
 *  - chat_message_log: append-only audit backing message-permission enforcement
 *  - group_channels / group_members: mirror of group membership for admin checks
 *  - media_assets: S3-backed uploads for chat/status
 *
 * The legacy native-Postgres chat tables and all Matrix tables are dropped.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, bigint, timestamp, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt } from './_helpers';
import { users } from './users';

export const chatChannels = pgTable(
  'chat_channels',
  {
    channelCid: text('channel_cid').primaryKey(), // e.g. 'messaging:<uuidA>__<uuidB>'
    memberLow: uuid('member_low')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    memberHigh: uuid('member_high')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_chat_channels_pair').on(t.memberLow, t.memberHigh),
    index('idx_chat_channels_low').on(t.memberLow),
    index('idx_chat_channels_high').on(t.memberHigh),
  ],
);

export const chatMessageLog = pgTable(
  'chat_message_log',
  {
    messageId: text('message_id').primaryKey(), // Stream message id
    channelCid: text('channel_cid').notNull(),
    senderId: uuid('sender_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    recipientId: uuid('recipient_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_chat_msg_sender_recipient').on(t.senderId, t.recipientId, t.createdAt.desc()),
    index('idx_chat_msg_channel').on(t.channelCid, t.createdAt.desc()),
  ],
);

export const groupChannels = pgTable(
  'group_channels',
  {
    groupId: uuid('group_id').primaryKey().defaultRandom(),
    channelCid: text('channel_cid').notNull().unique(), // 'messaging:group-<uuid>'
    name: text('name').notNull(),
    description: text('description'),
    avatarUrl: text('avatar_url'),
    // Shared content: survives creator deletion (remaining members keep the group).
    createdBy: uuid('created_by').references(() => users.userId, { onDelete: 'set null' }),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_group_channels_creator').on(t.createdBy),
    check('group_name_len', sql`char_length(trim(name)) >= 1 AND char_length(trim(name)) <= 100`),
  ],
);

export const groupMembers = pgTable(
  'group_members',
  {
    groupId: uuid('group_id')
      .notNull()
      .references(() => groupChannels.groupId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    role: text('role').notNull().default('member'),
    joinedAt: timestamp('joined_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => [
    primaryKey({ columns: [t.groupId, t.userId] }),
    index('idx_group_members_user_id').on(t.userId),
    check('group_member_role_check', sql`role IN ('admin','member')`),
  ],
);

export const mediaAssets = pgTable('media_assets', {
  mediaRef: text('media_ref').primaryKey(),
  ownerId: uuid('owner_id')
    .notNull()
    .references(() => users.userId, { onDelete: 'cascade' }),
  kind: text('kind').notNull(),
  sizeBytes: bigint('size_bytes', { mode: 'number' }),
  thumbRef: text('thumb_ref'),
  s3Key: text('s3_key').notNull(),
  status: text('status').notNull().default('ready'),
  createdAt: createdAt(),
});
