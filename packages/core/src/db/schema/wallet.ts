/**
 * Wallet + payments. All money is BIGINT paise. Wallet transactions are an
 * append-only ledger; `ref` is unique so provider callbacks are idempotent.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, bigint, integer, boolean, jsonb, index, uniqueIndex, check } from 'drizzle-orm/pg-core';
import { walletTxnType, walletTxnStatus, paymentOrderStatus, privacySubStatus } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const wallets = pgTable('wallets', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  balancePaise: bigint('balance_paise', { mode: 'number' }).notNull().default(0),
  autoRechargeEnabled: boolean('auto_recharge_enabled').notNull().default(false),
  autoRechargePackId: text('auto_recharge_pack_id'),
  autoRechargeThresholdPaise: bigint('auto_recharge_threshold_paise', { mode: 'number' }),
  updatedAt: updatedAt(),
}, (t) => [check('wallet_balance_nonneg', sql`balance_paise >= 0`)]);

export const walletTransactions = pgTable(
  'wallet_transactions',
  {
    txnId: uuid('txn_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    type: walletTxnType('type').notNull(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    minutes: integer('minutes'),
    ref: text('ref'),
    status: walletTxnStatus('status').notNull().default('completed'),
    balanceAfter: bigint('balance_after', { mode: 'number' }),
    meta: jsonb('meta').notNull().default(sql`'{}'::jsonb`),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('idx_wallet_txn_ref_unique').on(t.ref).where(sql`ref IS NOT NULL`),
    index('idx_wallet_txn_user_created').on(t.userId, t.createdAt.desc()),
  ],
);

export const paymentOrders = pgTable(
  'payment_orders',
  {
    orderId: uuid('order_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    razorpayOrderId: text('razorpay_order_id').notNull().unique(),
    amountPaise: bigint('amount_paise', { mode: 'number' }).notNull(),
    packId: text('pack_id').notNull(),
    status: paymentOrderStatus('status').notNull().default('created'),
    createdAt: createdAt(),
    paidAt: ts('paid_at'),
  },
  (t) => [index('idx_payment_orders_user').on(t.userId, t.createdAt.desc())],
);

export const privacySubscriptions = pgTable('privacy_subscriptions', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => users.userId, { onDelete: 'cascade' }),
  plan: text('plan').notNull().default('privacy_pack'),
  status: privacySubStatus('status').notNull().default('none'),
  minutesIncluded: integer('minutes_included').notNull().default(0),
  renewsAt: ts('renews_at'),
  razorpaySubId: text('razorpay_sub_id'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});
