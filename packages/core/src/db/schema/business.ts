/**
 * Business Suite: verified companies, their broadcast channels, user subscriptions,
 * messages + per-subscriber deliveries, and user-side blocks/reports. API-key auth
 * lives in the business module (folded from the old business-api service).
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import {
  businessStatus,
  businessPlan,
  businessChannelType,
  businessSubscriptionStatus,
  businessMessageStatus,
  businessDeliveryStatus,
} from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const businesses = pgTable(
  'businesses',
  {
    businessId: uuid('business_id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    gstin: text('gstin'),
    cin: text('cin'),
    category: text('category').notNull(),
    contactEmail: text('contact_email').notNull(),
    website: text('website'),
    logoUrl: text('logo_url'),
    status: businessStatus('status').notNull().default('pending'),
    apiKeyHash: text('api_key_hash'),
    plan: businessPlan('plan').notNull().default('starter'),
    rejectionReason: text('rejection_reason'),
    verifiedHandle: text('verified_handle'),
    entityKycRef: text('entity_kyc_ref'),
    verifiedAt: ts('verified_at'),
    suspendedAt: ts('suspended_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('idx_businesses_gstin').on(t.gstin).where(sql`gstin IS NOT NULL AND status != 'rejected'`),
    uniqueIndex('idx_businesses_verified_handle')
      .on(t.verifiedHandle)
      .where(sql`verified_handle IS NOT NULL AND status = 'verified'`),
    check(
      'businesses_gstin_format',
      sql`gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'`,
    ),
  ],
);

export const businessChannels = pgTable(
  'business_channels',
  {
    channelId: uuid('channel_id').primaryKey().defaultRandom(),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.businessId, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    channelType: businessChannelType('channel_type').notNull().default('transactional'),
    dailyLimitPerSubscriber: integer('daily_limit_per_subscriber').notNull().default(10),
    active: boolean('active').notNull().default(true),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_business_channels_business').on(t.businessId),
    check('business_channel_daily_limit', sql`daily_limit_per_subscriber >= 1 AND daily_limit_per_subscriber <= 100`),
  ],
);

export const businessSubscriptions = pgTable(
  'business_subscriptions',
  {
    subscriptionId: uuid('subscription_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.businessId, { onDelete: 'cascade' }),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => businessChannels.channelId, { onDelete: 'cascade' }),
    status: businessSubscriptionStatus('status').notNull().default('pending'),
    subscribedAt: ts('subscribed_at'),
    cancelledAt: ts('cancelled_at'),
    lastReadAt: ts('last_read_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('business_subscriptions_user_channel').on(t.userId, t.channelId),
    index('idx_business_subscriptions_channel_status').on(t.channelId, t.status),
    index('idx_business_subscriptions_user').on(t.userId, t.status),
  ],
);

export const businessMessages = pgTable(
  'business_messages',
  {
    messageId: uuid('message_id').primaryKey().defaultRandom(),
    channelId: uuid('channel_id')
      .notNull()
      .references(() => businessChannels.channelId, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.businessId, { onDelete: 'cascade' }),
    content: text('content').notNull(),
    templateId: text('template_id'),
    totalSubscribers: integer('total_subscribers').notNull().default(0),
    totalDelivered: integer('total_delivered').notNull().default(0),
    totalFailed: integer('total_failed').notNull().default(0),
    status: businessMessageStatus('status').notNull().default('queued'),
    scheduledAt: ts('scheduled_at'),
    sentAt: ts('sent_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_business_messages_channel_created').on(t.channelId, t.createdAt.desc()),
    check('business_message_content_len', sql`length(trim(content)) >= 1 AND length(content) <= 4096`),
  ],
);

export const businessMessageDeliveries = pgTable(
  'business_message_deliveries',
  {
    deliveryId: uuid('delivery_id').primaryKey().defaultRandom(),
    messageId: uuid('message_id')
      .notNull()
      .references(() => businessMessages.messageId, { onDelete: 'cascade' }),
    subscriptionId: uuid('subscription_id')
      .notNull()
      .references(() => businessSubscriptions.subscriptionId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    status: businessDeliveryStatus('status').notNull().default('pending'),
    errorMessage: text('error_message'),
    deliveredAt: ts('delivered_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('business_deliveries_message_sub').on(t.messageId, t.subscriptionId),
    index('idx_business_deliveries_message').on(t.messageId, t.status),
  ],
);

export const businessBlocks = pgTable(
  'business_blocks',
  {
    blockId: uuid('block_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.businessId, { onDelete: 'cascade' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('uq_business_blocks_user_biz').on(t.userId, t.businessId), index('idx_business_blocks_user').on(t.userId)],
);

export const businessReports = pgTable(
  'business_reports',
  {
    reportId: uuid('report_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    businessId: uuid('business_id')
      .notNull()
      .references(() => businesses.businessId, { onDelete: 'cascade' }),
    reason: text('reason'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_business_reports_biz').on(t.businessId, t.createdAt.desc())],
);
