/**
 * In-app calls (Stream Video). `stream_call_id` is the media room id (renamed from
 * the legacy `webrtc_room_id`). Quality reports are one-per-participant-per-call.
 * behavior_events is the append-only signal log feeding trust + abuse detection.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, numeric, jsonb, index, uniqueIndex } from 'drizzle-orm/pg-core';
import { callType, callStatus } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';
import { reachabilityChannels } from './reachability';

export const calls = pgTable(
  'calls',
  {
    callId: uuid('call_id').primaryKey().defaultRandom(),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    calleeId: uuid('callee_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    callType: callType('call_type').notNull().default('direct'),
    status: callStatus('status').notNull().default('initiated'),
    channelId: uuid('channel_id').references(() => reachabilityChannels.channelId, { onDelete: 'set null' }),
    streamCallId: text('stream_call_id'),
    startedAt: ts('started_at'),
    endedAt: ts('ended_at'),
    durationSeconds: integer('duration_seconds'),
    declineReason: text('decline_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_calls_caller').on(t.callerId, t.createdAt.desc()),
    index('idx_calls_callee').on(t.calleeId, t.createdAt.desc()),
    index('idx_calls_open').on(t.calleeId, t.status).where(sql`status IN ('initiated','ringing')`),
  ],
);

export const callQualityReports = pgTable(
  'call_quality_reports',
  {
    reportId: uuid('report_id').primaryKey().defaultRandom(),
    callId: uuid('call_id')
      .notNull()
      .references(() => calls.callId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    mosScore: numeric('mos_score', { precision: 3, scale: 1 }),
    packetLossPct: numeric('packet_loss_pct', { precision: 5, scale: 2 }),
    jitterMs: integer('jitter_ms'),
    rttMs: integer('rtt_ms'),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('call_quality_reports_call_user_uniq').on(t.callId, t.userId)],
);

export const behaviorEvents = pgTable(
  'behavior_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    eventType: text('event_type').notNull(),
    targetUserId: uuid('target_user_id').references(() => users.userId, { onDelete: 'set null' }),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_behavior_events_user').on(t.userId, t.createdAt.desc()),
    index('idx_behavior_events_type').on(t.eventType, t.createdAt.desc()),
    index('idx_behavior_events_outreach').on(t.userId, t.eventType, t.createdAt.desc()),
  ],
);
