/**
 * Masked (PSTN) calling via a virtual-number pool. The callee's real number is only
 * ever stored hashed. Billing is in BIGINT paise.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, bigint, integer, index } from 'drizzle-orm/pg-core';
import { maskedCallStatus, numberPoolStatus } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const numberPool = pgTable('number_pool', {
  virtualNumber: text('virtual_number').primaryKey(),
  provider: text('provider').notNull().default('exotel'),
  status: numberPoolStatus('status').notNull().default('active'),
  assignedRef: text('assigned_ref'),
  updatedAt: updatedAt(),
});

export const maskedCalls = pgTable(
  'masked_calls',
  {
    callId: uuid('call_id').primaryKey().defaultRandom(),
    callerId: uuid('caller_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    calleeNumberHash: text('callee_number_hash').notNull(),
    calleeDisplay: text('callee_display'),
    virtualNumber: text('virtual_number'),
    providerRef: text('provider_ref').unique(),
    landingToken: text('landing_token').unique(),
    status: maskedCallStatus('status').notNull().default('placing'),
    holdPaise: bigint('hold_paise', { mode: 'number' }).notNull().default(0),
    billedSeconds: integer('billed_seconds').notNull().default(0),
    costPaise: bigint('cost_paise', { mode: 'number' }).notNull().default(0),
    startedAt: ts('started_at'),
    connectedAt: ts('connected_at'),
    endedAt: ts('ended_at'),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_masked_calls_caller').on(t.callerId, t.createdAt.desc()),
    index('idx_masked_calls_landing').on(t.landingToken).where(sql`landing_token IS NOT NULL`),
  ],
);

export const maskedCallReports = pgTable(
  'masked_call_reports',
  {
    reportId: uuid('report_id').primaryKey().defaultRandom(),
    virtualNumber: text('virtual_number'),
    callRef: text('call_ref'),
    reason: text('reason').notNull().default('unwanted'),
    reporterHash: text('reporter_hash'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_masked_reports_call_ref').on(t.callRef)],
);
