/**
 * Refer & Earn — the canonical (phase-6) model. The superseded first-generation
 * tables (referral_events, referral_withdrawals) are dropped; `referrals` is the
 * relationship of record, `referral_ledger` the transaction log, `referral_wallets`
 * the balance snapshot, and payouts go out via RazorpayX.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { referralLedgerType, referralStatus, payoutMethodType } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const referralCodes = pgTable(
  'referral_codes',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.userId, { onDelete: 'cascade' }),
    code: text('code').notNull().unique(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('idx_referral_codes_code_upper').on(sql`upper(${t.code})`)],
);

export const referralWallets = pgTable(
  'referral_wallets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => users.userId, { onDelete: 'cascade' }),
    totalEarnedPaise: integer('total_earned_paise').notNull().default(0),
    withdrawablePaise: integer('withdrawable_paise').notNull().default(0),
    pendingPaise: integer('pending_paise').notNull().default(0),
    withdrawalUnlocked: boolean('withdrawal_unlocked').notNull().default(false),
    updatedAt: updatedAt(),
  },
  (t) => [
    check('referral_wallet_nonneg', sql`total_earned_paise >= 0 AND withdrawable_paise >= 0 AND pending_paise >= 0`),
  ],
);

export const referrals = pgTable(
  'referrals',
  {
    referralId: uuid('referral_id').primaryKey().defaultRandom(),
    referrerId: uuid('referrer_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    referredId: uuid('referred_id')
      .notNull()
      .unique()
      .references(() => users.userId, { onDelete: 'cascade' }),
    code: text('code').notNull(),
    status: referralStatus('status').notNull().default('invited'),
    milestones: jsonb('milestones').notNull().default(sql`'{}'::jsonb`),
    qualifiedAt: ts('qualified_at'),
    rejectedReason: text('rejected_reason'),
    rewardPaise: integer('reward_paise').notNull().default(3000),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_referrals_referrer').on(t.referrerId, t.createdAt.desc()),
    index('idx_referrals_status').on(t.status, t.updatedAt),
  ],
);

export const referralLedger = pgTable(
  'referral_ledger',
  {
    entryId: uuid('entry_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    amountPaise: integer('amount_paise').notNull(),
    entryType: referralLedgerType('entry_type').notNull(),
    referenceId: uuid('reference_id'),
    description: text('description'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_referral_ledger_user').on(t.userId, t.createdAt.desc())],
);

export const referralAuditEvents = pgTable(
  'referral_audit_events',
  {
    eventId: uuid('event_id').primaryKey().defaultRandom(),
    referralId: uuid('referral_id').references(() => referrals.referralId, { onDelete: 'set null' }),
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    action: text('action').notNull(),
    fromStatus: text('from_status'),
    toStatus: text('to_status'),
    meta: jsonb('meta'),
    createdAt: createdAt(),
  },
  (t) => [index('idx_referral_audit_referral').on(t.referralId, t.createdAt.desc())],
);

export const payoutMethods = pgTable(
  'payout_methods',
  {
    methodId: uuid('method_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    type: payoutMethodType('type').notNull(),
    detailsMasked: text('details_masked').notNull(),
    holderName: text('holder_name'),
    verified: boolean('verified').notNull().default(false),
    fundAccountRef: text('fund_account_ref'),
    razorpayContactRef: text('razorpay_contact_ref'),
    isDefault: boolean('is_default').notNull().default(false),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_payout_methods_user').on(t.userId, t.createdAt.desc())],
);

export const payouts = pgTable(
  'payouts',
  {
    payoutId: uuid('payout_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    amountPaise: integer('amount_paise').notNull(),
    methodId: uuid('method_id').references(() => payoutMethods.methodId, { onDelete: 'set null' }),
    razorpayxRef: text('razorpayx_ref'),
    status: text('status').notNull().default('requested'),
    failureReason: text('failure_reason'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_payouts_user').on(t.userId, t.createdAt.desc()),
    check('payouts_amount_positive', sql`amount_paise > 0`),
    check('payouts_status_check', sql`status IN ('requested','processing','paid','failed')`),
  ],
);
