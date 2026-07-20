/**
 * In-app approval requests (Phase 3 of the authenticator story). A relying party —
 * TrustRoute itself, or later an external service like a bank/UPI app — asks a user
 * to approve an action ("Sign in to Acme", "Authorize ₹5,000"). The user approves or
 * denies IN THE APP with biometric, so nothing is sent over SMS and there's no code
 * to intercept or read aloud. This is the numberless-OTP endgame.
 *
 * Note: distinct from the KYC `verification_status` enum — this is action approval.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, index } from 'drizzle-orm/pg-core';
import { approvalStatus } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const approvalRequests = pgTable(
  'approval_requests',
  {
    requestId: uuid('request_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    /** Human-readable name of who's asking, shown to the user. */
    relyingParty: text('relying_party').notNull(),
    /** What is being approved, shown to the user. */
    action: text('action').notNull(),
    status: approvalStatus('status').notNull().default('pending'),
    /** Optional shown context (device, location, ip) — never secrets. */
    context: jsonb('context').notNull().default(sql`'{}'::jsonb`),
    expiresAt: ts('expires_at').notNull(),
    respondedAt: ts('responded_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('idx_approval_user_status').on(t.userId, t.status, t.createdAt.desc())],
);
