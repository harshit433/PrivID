/**
 * Users + per-device registration + refresh tokens.
 *
 * A user is the app-facing account; its durable anchor is `identity_id`. Push tokens
 * live on `device_registrations` (one home, per device) — never duplicated on users.
 * Legacy OTP sessions and the users.fcm_token column are intentionally dropped.
 */
import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, integer, boolean, jsonb, index, uniqueIndex, check, type AnyPgColumn } from 'drizzle-orm/pg-core';
import { trustTier, accountStatus, discoveryMode } from './_enums';
import { createdAt, updatedAt, ts } from './_helpers';
import { identities } from './identity';

const DEFAULT_NOTIFICATION_PREFS = sql`'{
  "calls": true, "messages": true, "group_messages": true, "company_updates": true,
  "referral": true, "trust_security": true, "sound": true, "vibrate": true
}'::jsonb`;

const DEFAULT_CONSENTS = sql`'{ "kyc_use": true, "analytics_opt_out": false }'::jsonb`;

export const users = pgTable(
  'users',
  {
    userId: uuid('user_id').primaryKey().defaultRandom(),
    identityId: uuid('identity_id').references((): AnyPgColumn => identities.identityId, { onDelete: 'set null' }),

    // Phone is now an optional reachability factor, not the anchor.
    phoneE164: text('phone_e164'),
    phoneHash: text('phone_hash'),

    handle: text('handle').notNull().unique(),
    displayName: text('display_name'),
    avatarUrl: text('avatar_url'),

    // Trust
    trustTier: trustTier('trust_tier').notNull().default('anonymous'),
    trustScore: integer('trust_score').notNull().default(0),
    isMonitored: boolean('is_monitored').notNull().default(false),
    warningCount: integer('warning_count').notNull().default(0),
    shadowTrustEnabled: boolean('shadow_trust_enabled').notNull().default(false),

    // Profile
    email: text('email'),
    profession: text('profession'),
    bio: text('bio'),
    businessInfo: text('business_info'),
    organisation: text('organisation'),
    address: text('address'),
    languagePref: text('language_pref').notNull().default('en'),

    // Identity / KYC (denormalized from identities for convenience)
    legalName: text('legal_name'),
    kycStatus: text('kyc_status').notNull().default('none'),
    kycProvider: text('kyc_provider'),
    kycVerifiedAt: ts('kyc_verified_at'),

    // Account lifecycle
    isActive: boolean('is_active').notNull().default(true),
    onboardingComplete: boolean('onboarding_complete').notNull().default(false),
    accountStatus: accountStatus('account_status').notNull().default('active'),
    accountStatusReason: text('account_status_reason'),
    accountStatusUpdatedAt: ts('account_status_updated_at').notNull().defaultNow(),
    isUnderReview: boolean('is_under_review').notNull().default(false),
    reviewReason: text('review_reason'),
    reviewStartedAt: ts('review_started_at'),
    callRestrictionUntil: ts('call_restriction_until'),
    deletedAt: ts('deleted_at'),
    suspendedAt: ts('suspended_at'),
    bannedAt: ts('banned_at'),
    purgeScheduledAt: ts('purge_scheduled_at'),

    // Login PIN (bcrypt; never returned to clients)
    pinHash: text('pin_hash'),
    pinSetAt: ts('pin_set_at'),
    pinFailedAttempts: integer('pin_failed_attempts').notNull().default(0),
    pinLockedUntil: ts('pin_locked_until'),
    handleChangedAt: ts('handle_changed_at'),

    // Presence + status
    statusText: text('status_text'),
    statusEmoji: text('status_emoji'),
    lastSeenAt: ts('last_seen_at'),

    // Discovery + preferences
    discoveryMode: discoveryMode('discovery_mode').notNull().default('public'),
    discoveryContactBookMatching: boolean('discovery_contact_book_matching').notNull().default(true),
    discoveryShowTrustScore: boolean('discovery_show_trust_score').notNull().default(true),
    notificationPrefs: jsonb('notification_prefs').notNull().default(DEFAULT_NOTIFICATION_PREFS),
    userConsents: jsonb('user_consents').notNull().default(DEFAULT_CONSENTS),

    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [
    uniqueIndex('uq_users_phone_hash').on(t.phoneHash).where(sql`phone_hash IS NOT NULL`),
    index('idx_users_handle').on(t.handle),
    index('idx_users_identity').on(t.identityId).where(sql`identity_id IS NOT NULL`),
    index('idx_users_account_status').on(t.accountStatus),
    index('idx_users_last_seen').on(t.lastSeenAt.desc()).where(sql`last_seen_at IS NOT NULL`),
    index('idx_users_under_review').on(t.isUnderReview).where(sql`is_under_review = TRUE`),
    index('idx_users_monitored').on(t.userId).where(sql`is_monitored = TRUE AND is_active = TRUE`),
    // One active account per government identity (the DB backstop for dedup).
    uniqueIndex('uq_users_active_identity')
      .on(t.identityId)
      .where(sql`identity_id IS NOT NULL AND account_status IN ('active','under_review','restricted','suspended')`),
    check('users_trust_score_check', sql`trust_score BETWEEN 0 AND 100`),
    check('users_status_text_len', sql`status_text IS NULL OR length(status_text) <= 140`),
    check('users_discovery_mode_check', sql`discovery_mode IN ('public','private')`),
  ],
);

export const deviceRegistrations = pgTable(
  'device_registrations',
  {
    deviceId: uuid('device_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    pushToken: text('push_token'),
    platform: text('platform').notNull(),
    devicePubKey: text('device_pub_key'),
    integrityToken: text('integrity_token'),
    deviceFingerprint: text('device_fingerprint'),
    hardwareId: text('hardware_id'),
    lastSeenAt: ts('last_seen_at').notNull().defaultNow(),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_devices_user').on(t.userId),
    index('idx_devices_hardware_id').on(t.hardwareId).where(sql`hardware_id IS NOT NULL`),
    index('idx_devices_fingerprint').on(t.deviceFingerprint).where(sql`device_fingerprint IS NOT NULL`),
    index('idx_devices_push_token').on(t.userId).where(sql`push_token IS NOT NULL`),
    uniqueIndex('uq_device_user_hardware').on(t.userId, t.hardwareId),
    check('device_platform_check', sql`platform IN ('ios','android')`),
  ],
);

export const refreshTokens = pgTable(
  'refresh_tokens',
  {
    tokenId: uuid('token_id').primaryKey().defaultRandom(),
    userId: uuid('user_id')
      .notNull()
      .references(() => users.userId, { onDelete: 'cascade' }),
    tokenHash: text('token_hash').notNull().unique(),
    deviceId: text('device_id'),
    expiresAt: ts('expires_at').notNull(),
    revoked: boolean('revoked').notNull().default(false),
    createdAt: createdAt(),
  },
  (t) => [
    index('idx_refresh_tokens_user').on(t.userId),
    index('idx_refresh_tokens_active').on(t.tokenHash).where(sql`revoked = FALSE`),
  ],
);
