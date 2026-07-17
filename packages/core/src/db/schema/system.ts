/**
 * Cross-cutting system tables: async account jobs (data export, handle propagation),
 * the feature-flag store, and public marketing-site form captures.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, smallint, jsonb, index, check } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const dataExportRequests = pgTable(
  'data_export_requests',
  {
    requestId: uuid('request_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    status: text('status').notNull().default('requested'),
    email: text('email'),
    downloadUrl: text('download_url'),
    expiresAt: ts('expires_at'),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('idx_data_export_user').on(t.userId, t.createdAt.desc()),
    check('data_export_status_check', sql`status IN ('requested','processing','ready','failed','expired')`),
  ],
);

export const handlePropagationJobs = pgTable(
  'handle_propagation_jobs',
  {
    jobId: uuid('job_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    oldHandle: text('old_handle').notNull(),
    newHandle: text('new_handle').notNull(),
    status: text('status').notNull().default('pending'),
    connectionsUpdated: integer('connections_updated').notNull().default(0),
    createdAt: createdAt(),
    completedAt: ts('completed_at'),
  },
  (t) => [
    index('idx_handle_propagation_pending').on(t.status, t.createdAt).where(sql`status IN ('pending','processing')`),
    check('handle_propagation_status_check', sql`status IN ('pending','processing','done','failed')`),
  ],
);

export const featureFlags = pgTable('feature_flags', {
  key: text('key').primaryKey(),
  value: jsonb('value').notNull().default(sql`'true'::jsonb`),
  updatedAt: updatedAt(),
});

export const websiteContactMessages = pgTable(
  'website_contact_messages',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    message: text('message').notNull(),
    source: text('source'),
    page: text('page'),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    index('website_contact_messages_created_at_idx').on(t.createdAt.desc()),
    index('website_contact_messages_email_idx').on(sql`lower(${t.email})`),
  ],
);

export const websiteWaitlistSignups = pgTable(
  'website_waitlist_signups',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    interestLevel: smallint('interest_level').notNull(),
    whyBetter: text('why_better').notNull(),
    whyWilling: text('why_willing').notNull(),
    source: text('source'),
    page: text('page'),
    userAgent: text('user_agent'),
    ipHash: text('ip_hash'),
    createdAt: createdAt(),
  },
  (t) => [
    index('website_waitlist_signups_created_at_idx').on(t.createdAt.desc()),
    index('website_waitlist_signups_email_idx').on(sql`lower(${t.email})`),
    index('website_waitlist_signups_interest_idx').on(t.interestLevel),
    check('waitlist_interest_range', sql`interest_level BETWEEN 1 AND 5`),
  ],
);
