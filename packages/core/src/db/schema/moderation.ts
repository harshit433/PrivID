/**
 * Moderation: trust-weighted user reports + the immutable admin action audit log.
 * Audit rows outlive their subject (target_id → SET NULL) so accountability records
 * are never lost when a user is deleted.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, boolean, numeric, jsonb, index, check } from 'drizzle-orm/pg-core';
import { reportReasonType, reportContextType } from './_enums';
import { createdAt } from './_helpers';
import { users } from './users';

export const userReports = pgTable(
  'user_reports',
  {
    reportId: uuid('report_id').primaryKey().defaultRandom(),
    reporterId: uuid('reporter_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    reportedUserId: uuid('reported_user_id').references(() => users.userId, { onDelete: 'set null' }),
    reportedNumberE164: text('reported_number_e164'),
    reasonType: reportReasonType('reason_type').notNull(),
    note: text('note'),
    contextType: reportContextType('context_type'),
    contextId: text('context_id'),
    signalWeight: numeric('signal_weight', { precision: 4, scale: 2 }).notNull().default('1.00'),
    blockAlso: boolean('block_also').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_user_reports_target_user').on(t.reportedUserId, t.createdAt.desc()).where(sql`reported_user_id IS NOT NULL`),
    index('idx_user_reports_target_number')
      .on(t.reportedNumberE164, t.createdAt.desc())
      .where(sql`reported_number_e164 IS NOT NULL`),
    index('idx_user_reports_reporter').on(t.reporterId, t.createdAt.desc()),
    check('user_reports_subject_check', sql`reported_user_id IS NOT NULL OR reported_number_e164 IS NOT NULL`),
  ],
);

export const adminActions = pgTable(
  'admin_actions',
  {
    actionId: uuid('action_id').primaryKey().defaultRandom(),
    targetId: uuid('target_id').references(() => users.userId, { onDelete: 'set null' }),
    action: text('action').notNull(),
    adminRef: text('admin_ref'),
    note: text('note'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_admin_actions_target').on(t.targetId, t.createdAt.desc()).where(sql`target_id IS NOT NULL`),
    index('idx_admin_actions_type').on(t.action, t.createdAt.desc()),
    index('idx_admin_actions_recent').on(t.createdAt.desc()),
  ],
);
