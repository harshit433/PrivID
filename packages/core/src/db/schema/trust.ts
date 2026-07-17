/**
 * Trust: verification factors + score history, plus Shadow Trust (crowd-sourced
 * reputation for non-TrustRoute numbers, keyed by SHA-256 phone hash — raw numbers
 * never reach the server).
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, jsonb, numeric, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { verificationStatus, trustTier } from './_enums';
import { createdAt, ts } from './_helpers';
import { users } from './users';

export const trustFactors = pgTable(
  'trust_factors',
  {
    factorId: uuid('factor_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    factorType: text('factor_type').notNull(),
    status: verificationStatus('status').notNull().default('pending'),
    provider: text('provider'),
    providerRef: text('provider_ref'),
    scoreDelta: integer('score_delta').notNull().default(0),
    isLatest: boolean('is_latest').notNull().default(true),
    verifiedAt: ts('verified_at'),
    expiresAt: ts('expires_at'),
    metadata: jsonb('metadata').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_trust_factors_user').on(t.userId),
    index('idx_trust_factors_type').on(t.userId, t.factorType),
    uniqueIndex('idx_trust_factors_user_type_latest').on(t.userId, t.factorType).where(sql`is_latest = TRUE`),
    index('idx_trust_factors_completed')
      .on(t.userId, t.factorType, t.status)
      .where(sql`status = 'completed' AND is_latest = TRUE`),
  ],
);

export const trustScoreHistory = pgTable(
  'trust_score_history',
  {
    historyId: uuid('history_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    oldScore: integer('old_score').notNull(),
    newScore: integer('new_score').notNull(),
    oldTier: trustTier('old_tier').notNull(),
    newTier: trustTier('new_tier').notNull(),
    reason: text('reason').notNull(),
    createdAt: createdAt(),
  },
  (t) => [index('idx_trust_history_user').on(t.userId, t.createdAt.desc())],
);

export const dialerObservations = pgTable(
  'dialer_observations',
  {
    obsId: uuid('obs_id').primaryKey().defaultRandom(),
    observerId: uuid('observer_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    phoneHash: text('phone_hash').notNull(),
    outcome: text('outcome').notNull(),
    direction: text('direction'),
    isContact: boolean('is_contact').notNull().default(false),
    isTrustrouteUser: boolean('is_trustroute_user').notNull().default(false),
    contextLabel: text('context_label'),
    weight: numeric('weight', { precision: 4, scale: 3 }).notNull().default('1.000'),
    durationS: integer('duration_s'),
    observedAt: ts('observed_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_obs_phone_recent').on(t.phoneHash, t.observedAt.desc()),
    index('idx_obs_observer').on(t.observerId, t.observedAt.desc()),
    // One observation per observer/number/hour (anti-spam). AT TIME ZONE 'UTC' makes it IMMUTABLE.
    uniqueIndex('idx_obs_dedup').on(t.observerId, t.phoneHash, sql`date_trunc('hour', observed_at AT TIME ZONE 'UTC')`),
    check('dialer_observations_direction_check', sql`direction IS NULL OR direction IN ('incoming','outgoing')`),
    check(
      'dialer_observations_outcome_check',
      sql`outcome IN ('picked_up','declined','blocked','saved','hung_up_fast','incoming_accepted','incoming_declined','incoming_missed','incoming_blocked','outgoing_answered','outgoing_missed','outgoing_declined')`,
    ),
    check('dialer_observations_weight_check', sql`weight >= 0 AND weight <= 1`),
  ],
);

export const shadowNumbers = pgTable(
  'shadow_numbers',
  {
    phoneHash: text('phone_hash').primaryKey(),
    pickRate: numeric('pick_rate', { precision: 5, scale: 4 }).notNull().default('0'),
    declinedRate: numeric('declined_rate', { precision: 5, scale: 4 }).notNull().default('0'),
    blockRate: numeric('block_rate', { precision: 5, scale: 4 }).notNull().default('0'),
    saveRate: numeric('save_rate', { precision: 5, scale: 4 }).notNull().default('0'),
    hungFastRate: numeric('hung_fast_rate', { precision: 5, scale: 4 }).notNull().default('0'),
    observationCount: integer('observation_count').notNull().default(0),
    shadowScore: integer('shadow_score').notNull().default(50),
    lastUpdatedAt: ts('last_updated_at').notNull().defaultNow(),
  },
  (t) => [
    index('idx_shadow_score').on(t.shadowScore).where(sql`observation_count >= 5`),
    check('shadow_score_range', sql`shadow_score BETWEEN 0 AND 100`),
  ],
);
