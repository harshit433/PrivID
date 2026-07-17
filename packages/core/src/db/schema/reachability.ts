/**
 * Reachability channels (tokenised inbound call/message grants) + contact shares
 * (permanent + disposable QR/handle share links) and their usage logs.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { channelStatus } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const reachabilityChannels = pgTable(
  'reachability_channels',
  {
    channelId: uuid('channel_id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    token: text('token')
      .notNull()
      .unique()
      .default(sql`replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_')`),
    label: text('label'),
    status: channelStatus('status').notNull().default('active'),
    dailyLimit: integer('daily_limit').notNull().default(3),
    totalLimit: integer('total_limit'),
    useCount: integer('use_count').notNull().default(0),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_channels_owner').on(t.ownerId), index('idx_channels_token').on(t.token)],
);

export const channelUsageLog = pgTable(
  'channel_usage_log',
  {
    logId: uuid('log_id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => reachabilityChannels.channelId, { onDelete: 'cascade' }),
    callerId: uuid('caller_id').references(() => users.userId, { onDelete: 'set null' }),
    action: text('action').notNull(),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [index('idx_channel_usage').on(t.channelId, t.createdAt.desc())],
);

export const contactShares = pgTable(
  'contact_shares',
  {
    shareId: uuid('share_id').primaryKey().defaultRandom(),
    ownerId: uuid('owner_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    type: text('type').notNull(),
    label: text('label'),
    receiveOnly: boolean('receive_only').notNull().default(true),
    expiresAt: ts('expires_at'),
    maxUses: integer('max_uses'),
    uses: integer('uses').notNull().default(0),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    revokedAt: ts('revoked_at'),
  },
  (t) => [
    index('idx_contact_shares_owner_active').on(t.ownerId, t.active, t.createdAt.desc()),
    index('idx_contact_shares_token_active').on(t.token).where(sql`active = TRUE`),
    check('contact_shares_type_check', sql`type IN ('permanent','disposable')`),
  ],
);

export const shareEvents = pgTable(
  'share_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    shareId: uuid('share_id')
      .notNull()
      .references(() => contactShares.shareId, { onDelete: 'cascade' }),
    scannerId: uuid('scanner_id').references(() => users.userId, { onDelete: 'set null' }),
    deviceHash: text('device_hash'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_share_events_share').on(t.shareId, t.createdAt.desc())],
);
