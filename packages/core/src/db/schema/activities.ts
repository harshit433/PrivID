/**
 * Activity sessions: shared experiences (watch-together / screen-share) scoped to a
 * direct pair or a group. Durable metadata here; live state mirrors to Firebase RTDB
 * and media flows over Stream Video (`stream_call_id`, renamed from livekit_room_id).
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, jsonb, index, uniqueIndex, primaryKey, check } from 'drizzle-orm/pg-core';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';
import { groupChannels } from './chat';

export const activitySessions = pgTable(
  'activity_sessions',
  {
    activityId: uuid('activity_id').primaryKey().defaultRandom(),
    scopeType: text('scope_type').notNull(),
    directMemberLow: uuid('direct_member_low').references(() => users.userId, { onDelete: 'cascade' }),
    directMemberHigh: uuid('direct_member_high').references(() => users.userId, { onDelete: 'cascade' }),
    groupId: uuid('group_id').references(() => groupChannels.groupId, { onDelete: 'cascade' }),
    adapter: text('adapter').notNull(),
    status: text('status').notNull().default('active'),
    streamCallId: text('stream_call_id').notNull().unique(),
    hostUserId: uuid('host_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    controllerUserId: uuid('controller_user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    presenterUserId: uuid('presenter_user_id').references(() => users.userId, { onDelete: 'set null' }),
    createdBy: uuid('created_by')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    lastState: jsonb('last_state').notNull().default(sql`'{}'::jsonb`),
    stateRevision: integer('state_revision').notNull().default(0),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
    endedAt: ts('ended_at'),
  },
  (t) => [
    index('idx_activity_sessions_direct')
      .on(t.directMemberLow, t.directMemberHigh, t.status, t.createdAt.desc())
      .where(sql`scope_type = 'direct'`),
    index('idx_activity_sessions_group').on(t.groupId, t.status, t.createdAt.desc()).where(sql`scope_type = 'group'`),
    uniqueIndex('idx_one_active_direct_session')
      .on(t.directMemberLow, t.directMemberHigh)
      .where(sql`scope_type = 'direct' AND status = 'active'`),
    uniqueIndex('idx_one_active_group_session').on(t.groupId).where(sql`scope_type = 'group' AND status = 'active'`),
    check('activity_scope_check', sql`scope_type IN ('direct','group')`),
    check('activity_adapter_check', sql`adapter IN ('youtube','screen_share')`),
    check('activity_status_check', sql`status IN ('active','ended')`),
    check(
      'activity_scope_consistency',
      sql`(scope_type = 'direct' AND direct_member_low IS NOT NULL AND direct_member_high IS NOT NULL AND direct_member_low <> direct_member_high AND group_id IS NULL) OR (scope_type = 'group' AND group_id IS NOT NULL AND direct_member_low IS NULL AND direct_member_high IS NULL)`,
    ),
  ],
);

export const activityParticipants = pgTable(
  'activity_participants',
  {
    activityId: uuid('activity_id')
      .notNull()
      .references(() => activitySessions.activityId, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    role: text('role').notNull().default('participant'),
    joinedAt: ts('joined_at').notNull().defaultNow(),
    leftAt: ts('left_at'),
  },
  (t) => [
    primaryKey({ columns: [t.activityId, t.userId] }),
    index('idx_activity_participants_user').on(t.userId, t.leftAt),
    check('activity_participant_role_check', sql`role IN ('host','participant')`),
  ],
);
