/**
 * Identity is the durable account anchor: a government-verified identity (via KYC)
 * that at most one active user account may hold. Onboarding sessions drive the
 * signup/recovery state machine; appeals are first-class moderation records.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, jsonb, index, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { identityStatus, appealStatus } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { users } from './users';

export const identities = pgTable(
  'identities',
  {
    identityId: uuid('identity_id').primaryKey().defaultRandom(),
    legalName: text('legal_name').notNull(),
    docType: text('doc_type').notNull().default('aadhaar'),
    docHash: text('doc_hash').notNull().unique(),
    provider: text('provider').notNull().default('setu'),
    providerRef: text('provider_ref'),
    faceRef: text('face_ref'),
    status: identityStatus('status').notNull().default('active'),
    // Nullable + SET NULL: an identity outlives the user rows that held it.
    currentUserId: uuid('current_user_id').references((): AnyPgColumn => users.userId, { onDelete: 'set null' }),
    lastHandle: text('last_handle'),
    statusReason: text('status_reason'),
    bannedReason: text('banned_reason'),
    deletedAt: ts('deleted_at'),
    suspendedAt: ts('suspended_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_identities_status').on(t.status),
    index('idx_identities_current_user').on(t.currentUserId).where(sql`current_user_id IS NOT NULL`),
  ],
);

export const onboardingSessions = pgTable(
  'onboarding_sessions',
  {
    sessionId: uuid('session_id').primaryKey().defaultRandom(),
    purpose: text('purpose').notNull(),
    status: text('status').notNull().default('started'),
    deviceFingerprintHash: text('device_fingerprint_hash'),
    integrityVerdict: jsonb('integrity_verdict').notNull().default(sql`'{}'::jsonb`),
    digilockerProviderRef: text('digilocker_provider_ref'),
    livenessProviderRef: text('liveness_provider_ref'),
    legalName: text('legal_name'),
    docType: text('doc_type'),
    docHash: text('doc_hash'),
    identityId: uuid('identity_id').references(() => identities.identityId, { onDelete: 'set null' }),
    matchedUserId: uuid('matched_user_id').references(() => users.userId, { onDelete: 'set null' }),
    branch: text('branch'),
    selectedHandle: text('selected_handle'),
    pendingDisplayName: text('pending_display_name'),
    // Ephemeral face-match images — purged when the session completes/expires.
    docPhotoB64: text('doc_photo_b64'),
    selfieB64: text('selfie_b64'),
    expiresAt: ts('expires_at').notNull().default(sql`now() + interval '20 minutes'`),
    completedAt: ts('completed_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_onboarding_sessions_expires').on(t.expiresAt),
    index('idx_onboarding_sessions_identity').on(t.identityId).where(sql`identity_id IS NOT NULL`),
    check('onboarding_sessions_purpose_check', sql`purpose IN ('signup','recovery','pin_reset')`),
    check(
      'onboarding_sessions_status_check',
      sql`status IN ('started','device_checked','digilocker_started','digilocker_verified','liveness_started','liveness_verified','matched','completed','expired')`,
    ),
    check('onboarding_sessions_branch_check', sql`branch IS NULL OR branch IN ('new','self_deleted','active','suspended','banned','ousted','no_match')`),
  ],
);

export const accountAppeals = pgTable(
  'account_appeals',
  {
    appealId: uuid('appeal_id').primaryKey().defaultRandom(),
    userId: uuid('user_id').references(() => users.userId, { onDelete: 'set null' }),
    identityId: uuid('identity_id').references(() => identities.identityId, { onDelete: 'set null' }),
    status: appealStatus('status').notNull().default('submitted'),
    reason: text('reason').notNull(),
    evidence: text('evidence'),
    resolution: text('resolution'),
    resolvedBy: text('resolved_by'),
    reviewerMessage: text('reviewer_message'),
    resolvedAt: ts('resolved_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    index('idx_account_appeals_identity').on(t.identityId, t.createdAt.desc()).where(sql`identity_id IS NOT NULL`),
    index('idx_account_appeals_user').on(t.userId, t.createdAt.desc()).where(sql`user_id IS NOT NULL`),
    index('idx_account_appeals_status').on(t.status, t.createdAt.desc()),
    check('account_appeals_subject_check', sql`user_id IS NOT NULL OR identity_id IS NOT NULL`),
  ],
);
