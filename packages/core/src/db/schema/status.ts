/**
 * WhatsApp-style ephemeral status updates (24h TTL), text / image / video. Purged by
 * the status-expiry worker.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, index, check } from 'drizzle-orm/pg-core';
import { statusUpdateType } from './_enums';
import { createdAt, ts } from './_helpers';
import { users } from './users';

export const userStatusUpdates = pgTable(
  'user_status_updates',
  {
    statusId: uuid('status_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    type: statusUpdateType('type').notNull(),
    textBody: text('text_body'),
    mediaUrl: text('media_url'),
    mediaContentType: text('media_content_type'),
    durationMs: integer('duration_ms'),
    createdAt: createdAt(),
    expiresAt: ts('expires_at').notNull().default(sql`now() + interval '24 hours'`),
  },
  (t) => [
    index('idx_status_user_expires').on(t.userId, t.expiresAt.desc()),
    index('idx_status_expires').on(t.expiresAt),
    check('status_text_len', sql`text_body IS NULL OR (length(trim(text_body)) >= 1 AND length(text_body) <= 700)`),
    check('status_video_duration', sql`duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 60000)`),
    check(
      'status_media_by_type',
      sql`(type = 'text' AND text_body IS NOT NULL AND media_url IS NULL) OR (type IN ('image','video') AND media_url IS NOT NULL)`,
    ),
  ],
);
