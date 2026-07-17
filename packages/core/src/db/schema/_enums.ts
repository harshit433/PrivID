/**
 * All Postgres enums, declared once and reused across table definitions. Enum value
 * sets are the cleaned, canonical sets — legacy/dead values are not carried over.
 */
import { pgEnum } from 'drizzle-orm/pg-core';

// Identity / trust
export const trustTier = pgEnum('trust_tier', ['anonymous', 'basic', 'verified', 'premium']);
export const verificationStatus = pgEnum('verification_status', ['pending', 'completed', 'failed', 'expired']);
export const identityStatus = pgEnum('identity_status', ['active', 'self_deleted', 'suspended', 'banned', 'ousted']);
export const accountStatus = pgEnum('account_status', [
  'active',
  'under_review',
  'restricted',
  'suspended',
  'banned',
  'ousted',
  'self_deleted',
]);
export const appealStatus = pgEnum('appeal_status', ['submitted', 'in_review', 'restored', 'upheld', 'rejected']);
export const discoveryMode = pgEnum('discovery_mode', ['public', 'private']);

// Connections / reachability / calls
export const connectionType = pgEnum('connection_type', ['unknown', 'temporary', 'trusted', 'blocked']);
export const channelStatus = pgEnum('channel_status', ['active', 'expired', 'revoked']);
export const callType = pgEnum('call_type', ['direct', 'reachability']);
export const callStatus = pgEnum('call_status', [
  'initiated',
  'ringing',
  'answered',
  'ended',
  'missed',
  'declined',
  'failed',
]);

// Status updates
export const statusUpdateType = pgEnum('status_update_type', ['text', 'image', 'video']);

// Business suite
export const businessStatus = pgEnum('business_status', ['pending', 'verified', 'suspended', 'rejected']);
export const businessPlan = pgEnum('business_plan', ['starter', 'growth', 'enterprise']);
export const businessChannelType = pgEnum('business_channel_type', ['transactional', 'promotional', 'otp']);
export const businessSubscriptionStatus = pgEnum('business_subscription_status', ['pending', 'active', 'paused', 'cancelled']);
export const businessMessageStatus = pgEnum('business_message_status', ['queued', 'sending', 'sent', 'failed']);
export const businessDeliveryStatus = pgEnum('business_delivery_status', ['pending', 'delivered', 'failed']);

// Wallet / payments / masked calling
export const walletTxnType = pgEnum('wallet_txn_type', [
  'topup',
  'hold',
  'debit',
  'release',
  'refund',
  'referral_credit',
  'adjustment',
]);
export const walletTxnStatus = pgEnum('wallet_txn_status', ['pending', 'completed', 'failed', 'reversed']);
export const paymentOrderStatus = pgEnum('payment_order_status', ['created', 'paid', 'failed']);
export const privacySubStatus = pgEnum('privacy_sub_status', ['none', 'active', 'cancelled', 'past_due']);
export const maskedCallStatus = pgEnum('masked_call_status', [
  'placing',
  'ringing_caller',
  'ringing_callee',
  'connected',
  'ended',
  'failed',
  'cancelled',
]);
export const numberPoolStatus = pgEnum('number_pool_status', ['active', 'quarantined']);

// Referrals / payouts
export const referralLedgerType = pgEnum('referral_ledger_type', [
  'referrer_bonus',
  'referee_bonus',
  'pending_to_withdrawable',
  'withdrawal',
  'reversal',
  'earn',
  'payout',
  'convert_to_call',
]);
export const referralStatus = pgEnum('referral_status', [
  'invited',
  'verified',
  'qualifying',
  'qualified',
  'paid',
  'rejected',
]);
export const payoutMethodType = pgEnum('payout_method_type', ['upi', 'bank']);

// Reports
export const reportReasonType = pgEnum('report_reason_type', [
  'spam_scam',
  'harassment',
  'impersonation',
  'inappropriate',
  'other',
]);
export const reportContextType = pgEnum('report_context_type', ['call', 'chat', 'contact', 'profile', 'number', 'business']);
