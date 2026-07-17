CREATE TYPE "public"."account_status" AS ENUM('active', 'under_review', 'restricted', 'suspended', 'banned', 'ousted', 'self_deleted');--> statement-breakpoint
CREATE TYPE "public"."appeal_status" AS ENUM('submitted', 'in_review', 'restored', 'upheld', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."business_channel_type" AS ENUM('transactional', 'promotional', 'otp');--> statement-breakpoint
CREATE TYPE "public"."business_delivery_status" AS ENUM('pending', 'delivered', 'failed');--> statement-breakpoint
CREATE TYPE "public"."business_message_status" AS ENUM('queued', 'sending', 'sent', 'failed');--> statement-breakpoint
CREATE TYPE "public"."business_plan" AS ENUM('starter', 'growth', 'enterprise');--> statement-breakpoint
CREATE TYPE "public"."business_status" AS ENUM('pending', 'verified', 'suspended', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."business_subscription_status" AS ENUM('pending', 'active', 'paused', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."call_status" AS ENUM('initiated', 'ringing', 'answered', 'ended', 'missed', 'declined', 'failed');--> statement-breakpoint
CREATE TYPE "public"."call_type" AS ENUM('direct', 'reachability');--> statement-breakpoint
CREATE TYPE "public"."channel_status" AS ENUM('active', 'expired', 'revoked');--> statement-breakpoint
CREATE TYPE "public"."connection_type" AS ENUM('unknown', 'temporary', 'trusted', 'blocked');--> statement-breakpoint
CREATE TYPE "public"."discovery_mode" AS ENUM('public', 'private');--> statement-breakpoint
CREATE TYPE "public"."identity_status" AS ENUM('active', 'self_deleted', 'suspended', 'banned', 'ousted');--> statement-breakpoint
CREATE TYPE "public"."masked_call_status" AS ENUM('placing', 'ringing_caller', 'ringing_callee', 'connected', 'ended', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."number_pool_status" AS ENUM('active', 'quarantined');--> statement-breakpoint
CREATE TYPE "public"."payment_order_status" AS ENUM('created', 'paid', 'failed');--> statement-breakpoint
CREATE TYPE "public"."payout_method_type" AS ENUM('upi', 'bank');--> statement-breakpoint
CREATE TYPE "public"."privacy_sub_status" AS ENUM('none', 'active', 'cancelled', 'past_due');--> statement-breakpoint
CREATE TYPE "public"."referral_ledger_type" AS ENUM('referrer_bonus', 'referee_bonus', 'pending_to_withdrawable', 'withdrawal', 'reversal', 'earn', 'payout', 'convert_to_call');--> statement-breakpoint
CREATE TYPE "public"."referral_status" AS ENUM('invited', 'verified', 'qualifying', 'qualified', 'paid', 'rejected');--> statement-breakpoint
CREATE TYPE "public"."report_context_type" AS ENUM('call', 'chat', 'contact', 'profile', 'number', 'business');--> statement-breakpoint
CREATE TYPE "public"."report_reason_type" AS ENUM('spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other');--> statement-breakpoint
CREATE TYPE "public"."status_update_type" AS ENUM('text', 'image', 'video');--> statement-breakpoint
CREATE TYPE "public"."trust_tier" AS ENUM('anonymous', 'basic', 'verified', 'premium');--> statement-breakpoint
CREATE TYPE "public"."verification_status" AS ENUM('pending', 'completed', 'failed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."wallet_txn_status" AS ENUM('pending', 'completed', 'failed', 'reversed');--> statement-breakpoint
CREATE TYPE "public"."wallet_txn_type" AS ENUM('topup', 'hold', 'debit', 'release', 'refund', 'referral_credit', 'adjustment');--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "account_appeals" (
	"appeal_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid,
	"identity_id" uuid,
	"status" "appeal_status" DEFAULT 'submitted' NOT NULL,
	"reason" text NOT NULL,
	"evidence" text,
	"resolution" text,
	"resolved_by" text,
	"reviewer_message" text,
	"resolved_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "account_appeals_subject_check" CHECK (user_id IS NOT NULL OR identity_id IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "identities" (
	"identity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"legal_name" text NOT NULL,
	"doc_type" text DEFAULT 'aadhaar' NOT NULL,
	"doc_hash" text NOT NULL,
	"provider" text DEFAULT 'setu' NOT NULL,
	"provider_ref" text,
	"face_ref" text,
	"status" "identity_status" DEFAULT 'active' NOT NULL,
	"current_user_id" uuid,
	"last_handle" text,
	"status_reason" text,
	"banned_reason" text,
	"deleted_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "identities_doc_hash_unique" UNIQUE("doc_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "onboarding_sessions" (
	"session_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"purpose" text NOT NULL,
	"status" text DEFAULT 'started' NOT NULL,
	"device_fingerprint_hash" text,
	"integrity_verdict" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"digilocker_provider_ref" text,
	"liveness_provider_ref" text,
	"legal_name" text,
	"doc_type" text,
	"doc_hash" text,
	"identity_id" uuid,
	"matched_user_id" uuid,
	"branch" text,
	"selected_handle" text,
	"pending_display_name" text,
	"doc_photo_b64" text,
	"selfie_b64" text,
	"expires_at" timestamp with time zone DEFAULT now() + interval '20 minutes' NOT NULL,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "onboarding_sessions_purpose_check" CHECK (purpose IN ('signup','recovery','pin_reset')),
	CONSTRAINT "onboarding_sessions_status_check" CHECK (status IN ('started','device_checked','digilocker_started','digilocker_verified','liveness_started','liveness_verified','matched','completed','expired')),
	CONSTRAINT "onboarding_sessions_branch_check" CHECK (branch IS NULL OR branch IN ('new','self_deleted','active','suspended','banned','ousted','no_match'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "device_registrations" (
	"device_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"push_token" text,
	"platform" text NOT NULL,
	"device_pub_key" text,
	"integrity_token" text,
	"device_fingerprint" text,
	"hardware_id" text,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "device_platform_check" CHECK (platform IN ('ios','android'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "refresh_tokens" (
	"token_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"token_hash" text NOT NULL,
	"device_id" text,
	"expires_at" timestamp with time zone NOT NULL,
	"revoked" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "refresh_tokens_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "users" (
	"user_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"identity_id" uuid,
	"phone_e164" text,
	"phone_hash" text,
	"handle" text NOT NULL,
	"display_name" text,
	"avatar_url" text,
	"trust_tier" "trust_tier" DEFAULT 'anonymous' NOT NULL,
	"trust_score" integer DEFAULT 0 NOT NULL,
	"is_monitored" boolean DEFAULT false NOT NULL,
	"warning_count" integer DEFAULT 0 NOT NULL,
	"shadow_trust_enabled" boolean DEFAULT false NOT NULL,
	"email" text,
	"profession" text,
	"bio" text,
	"business_info" text,
	"organisation" text,
	"address" text,
	"language_pref" text DEFAULT 'en' NOT NULL,
	"legal_name" text,
	"kyc_status" text DEFAULT 'none' NOT NULL,
	"kyc_provider" text,
	"kyc_verified_at" timestamp with time zone,
	"is_active" boolean DEFAULT true NOT NULL,
	"onboarding_complete" boolean DEFAULT false NOT NULL,
	"account_status" "account_status" DEFAULT 'active' NOT NULL,
	"account_status_reason" text,
	"account_status_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"is_under_review" boolean DEFAULT false NOT NULL,
	"review_reason" text,
	"review_started_at" timestamp with time zone,
	"call_restriction_until" timestamp with time zone,
	"deleted_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"banned_at" timestamp with time zone,
	"purge_scheduled_at" timestamp with time zone,
	"pin_hash" text,
	"pin_set_at" timestamp with time zone,
	"pin_failed_attempts" integer DEFAULT 0 NOT NULL,
	"pin_locked_until" timestamp with time zone,
	"handle_changed_at" timestamp with time zone,
	"status_text" text,
	"status_emoji" text,
	"last_seen_at" timestamp with time zone,
	"discovery_mode" "discovery_mode" DEFAULT 'public' NOT NULL,
	"discovery_contact_book_matching" boolean DEFAULT true NOT NULL,
	"discovery_show_trust_score" boolean DEFAULT true NOT NULL,
	"notification_prefs" jsonb DEFAULT '{
  "calls": true, "messages": true, "group_messages": true, "company_updates": true,
  "referral": true, "trust_security": true, "sound": true, "vibrate": true
}'::jsonb NOT NULL,
	"user_consents" jsonb DEFAULT '{ "kyc_use": true, "analytics_opt_out": false }'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_handle_unique" UNIQUE("handle"),
	CONSTRAINT "users_trust_score_check" CHECK (trust_score BETWEEN 0 AND 100),
	CONSTRAINT "users_status_text_len" CHECK (status_text IS NULL OR length(status_text) <= 140),
	CONSTRAINT "users_discovery_mode_check" CHECK (discovery_mode IN ('public','private'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "dialer_observations" (
	"obs_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"observer_id" uuid NOT NULL,
	"phone_hash" text NOT NULL,
	"outcome" text NOT NULL,
	"direction" text,
	"is_contact" boolean DEFAULT false NOT NULL,
	"is_trustroute_user" boolean DEFAULT false NOT NULL,
	"context_label" text,
	"weight" numeric(4, 3) DEFAULT '1.000' NOT NULL,
	"duration_s" integer,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "dialer_observations_direction_check" CHECK (direction IS NULL OR direction IN ('incoming','outgoing')),
	CONSTRAINT "dialer_observations_outcome_check" CHECK (outcome IN ('picked_up','declined','blocked','saved','hung_up_fast','incoming_accepted','incoming_declined','incoming_missed','incoming_blocked','outgoing_answered','outgoing_missed','outgoing_declined')),
	CONSTRAINT "dialer_observations_weight_check" CHECK (weight >= 0 AND weight <= 1)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "shadow_numbers" (
	"phone_hash" text PRIMARY KEY NOT NULL,
	"pick_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"declined_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"block_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"save_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"hung_fast_rate" numeric(5, 4) DEFAULT '0' NOT NULL,
	"observation_count" integer DEFAULT 0 NOT NULL,
	"shadow_score" integer DEFAULT 50 NOT NULL,
	"last_updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shadow_score_range" CHECK (shadow_score BETWEEN 0 AND 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_factors" (
	"factor_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"factor_type" text NOT NULL,
	"status" "verification_status" DEFAULT 'pending' NOT NULL,
	"provider" text,
	"provider_ref" text,
	"score_delta" integer DEFAULT 0 NOT NULL,
	"is_latest" boolean DEFAULT true NOT NULL,
	"verified_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "trust_score_history" (
	"history_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"old_score" integer NOT NULL,
	"new_score" integer NOT NULL,
	"old_tier" "trust_tier" NOT NULL,
	"new_tier" "trust_tier" NOT NULL,
	"reason" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "connections" (
	"connection_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"contact_id" uuid NOT NULL,
	"connection_type" "connection_type" DEFAULT 'unknown' NOT NULL,
	"temporary_expires_at" timestamp with time zone,
	"daily_call_limit" integer,
	"contact_name" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "channel_usage_log" (
	"log_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"caller_id" uuid,
	"action" text NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "contact_shares" (
	"share_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token" text NOT NULL,
	"type" text NOT NULL,
	"label" text,
	"receive_only" boolean DEFAULT true NOT NULL,
	"expires_at" timestamp with time zone,
	"max_uses" integer,
	"uses" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"revoked_at" timestamp with time zone,
	CONSTRAINT "contact_shares_token_unique" UNIQUE("token"),
	CONSTRAINT "contact_shares_type_check" CHECK (type IN ('permanent','disposable'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "reachability_channels" (
	"channel_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"owner_id" uuid NOT NULL,
	"token" text DEFAULT replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_') NOT NULL,
	"label" text,
	"status" "channel_status" DEFAULT 'active' NOT NULL,
	"daily_limit" integer DEFAULT 3 NOT NULL,
	"total_limit" integer,
	"use_count" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "reachability_channels_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "share_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"share_id" uuid NOT NULL,
	"scanner_id" uuid,
	"device_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "behavior_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"event_type" text NOT NULL,
	"target_user_id" uuid,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "call_quality_reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"call_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"mos_score" numeric(3, 1),
	"packet_loss_pct" numeric(5, 2),
	"jitter_ms" integer,
	"rtt_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "calls" (
	"call_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_id" uuid NOT NULL,
	"callee_id" uuid NOT NULL,
	"call_type" "call_type" DEFAULT 'direct' NOT NULL,
	"status" "call_status" DEFAULT 'initiated' NOT NULL,
	"channel_id" uuid,
	"stream_call_id" text,
	"started_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"duration_seconds" integer,
	"decline_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "masked_call_reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"virtual_number" text,
	"call_ref" text,
	"reason" text DEFAULT 'unwanted' NOT NULL,
	"reporter_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "masked_calls" (
	"call_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"caller_id" uuid NOT NULL,
	"callee_number_hash" text NOT NULL,
	"callee_display" text,
	"virtual_number" text,
	"provider_ref" text,
	"landing_token" text,
	"status" "masked_call_status" DEFAULT 'placing' NOT NULL,
	"hold_paise" bigint DEFAULT 0 NOT NULL,
	"billed_seconds" integer DEFAULT 0 NOT NULL,
	"cost_paise" bigint DEFAULT 0 NOT NULL,
	"started_at" timestamp with time zone,
	"connected_at" timestamp with time zone,
	"ended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "masked_calls_provider_ref_unique" UNIQUE("provider_ref"),
	CONSTRAINT "masked_calls_landing_token_unique" UNIQUE("landing_token")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "number_pool" (
	"virtual_number" text PRIMARY KEY NOT NULL,
	"provider" text DEFAULT 'exotel' NOT NULL,
	"status" "number_pool_status" DEFAULT 'active' NOT NULL,
	"assigned_ref" text,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payment_orders" (
	"order_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"razorpay_order_id" text NOT NULL,
	"amount_paise" bigint NOT NULL,
	"pack_id" text NOT NULL,
	"status" "payment_order_status" DEFAULT 'created' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"paid_at" timestamp with time zone,
	CONSTRAINT "payment_orders_razorpay_order_id_unique" UNIQUE("razorpay_order_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "privacy_subscriptions" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"plan" text DEFAULT 'privacy_pack' NOT NULL,
	"status" "privacy_sub_status" DEFAULT 'none' NOT NULL,
	"minutes_included" integer DEFAULT 0 NOT NULL,
	"renews_at" timestamp with time zone,
	"razorpay_sub_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallet_transactions" (
	"txn_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "wallet_txn_type" NOT NULL,
	"amount_paise" bigint NOT NULL,
	"minutes" integer,
	"ref" text,
	"status" "wallet_txn_status" DEFAULT 'completed' NOT NULL,
	"balance_after" bigint,
	"meta" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"balance_paise" bigint DEFAULT 0 NOT NULL,
	"auto_recharge_enabled" boolean DEFAULT false NOT NULL,
	"auto_recharge_pack_id" text,
	"auto_recharge_threshold_paise" bigint,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "wallet_balance_nonneg" CHECK (balance_paise >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_channels" (
	"channel_cid" text PRIMARY KEY NOT NULL,
	"member_low" uuid NOT NULL,
	"member_high" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "chat_message_log" (
	"message_id" text PRIMARY KEY NOT NULL,
	"channel_cid" text NOT NULL,
	"sender_id" uuid NOT NULL,
	"recipient_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_channels" (
	"group_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_cid" text NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"avatar_url" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_channels_channel_cid_unique" UNIQUE("channel_cid"),
	CONSTRAINT "group_name_len" CHECK (char_length(trim(name)) >= 1 AND char_length(trim(name)) <= 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "group_members" (
	"group_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'member' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "group_members_group_id_user_id_pk" PRIMARY KEY("group_id","user_id"),
	CONSTRAINT "group_member_role_check" CHECK (role IN ('admin','member'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "media_assets" (
	"media_ref" text PRIMARY KEY NOT NULL,
	"owner_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"size_bytes" bigint,
	"thumb_ref" text,
	"s3_key" text NOT NULL,
	"status" text DEFAULT 'ready' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_status_updates" (
	"status_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "status_update_type" NOT NULL,
	"text_body" text,
	"media_url" text,
	"media_content_type" text,
	"duration_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone DEFAULT now() + interval '24 hours' NOT NULL,
	CONSTRAINT "status_text_len" CHECK (text_body IS NULL OR (length(trim(text_body)) >= 1 AND length(text_body) <= 700)),
	CONSTRAINT "status_video_duration" CHECK (duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 60000)),
	CONSTRAINT "status_media_by_type" CHECK ((type = 'text' AND text_body IS NOT NULL AND media_url IS NULL) OR (type IN ('image','video') AND media_url IS NOT NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_participants" (
	"activity_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role" text DEFAULT 'participant' NOT NULL,
	"joined_at" timestamp with time zone DEFAULT now() NOT NULL,
	"left_at" timestamp with time zone,
	CONSTRAINT "activity_participants_activity_id_user_id_pk" PRIMARY KEY("activity_id","user_id"),
	CONSTRAINT "activity_participant_role_check" CHECK (role IN ('host','participant'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "activity_sessions" (
	"activity_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"scope_type" text NOT NULL,
	"direct_member_low" uuid,
	"direct_member_high" uuid,
	"group_id" uuid,
	"adapter" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"stream_call_id" text NOT NULL,
	"host_user_id" uuid NOT NULL,
	"controller_user_id" uuid NOT NULL,
	"presenter_user_id" uuid,
	"created_by" uuid NOT NULL,
	"last_state" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"state_revision" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"ended_at" timestamp with time zone,
	CONSTRAINT "activity_sessions_stream_call_id_unique" UNIQUE("stream_call_id"),
	CONSTRAINT "activity_scope_check" CHECK (scope_type IN ('direct','group')),
	CONSTRAINT "activity_adapter_check" CHECK (adapter IN ('youtube','screen_share')),
	CONSTRAINT "activity_status_check" CHECK (status IN ('active','ended')),
	CONSTRAINT "activity_scope_consistency" CHECK ((scope_type = 'direct' AND direct_member_low IS NOT NULL AND direct_member_high IS NOT NULL AND direct_member_low <> direct_member_high AND group_id IS NULL) OR (scope_type = 'group' AND group_id IS NOT NULL AND direct_member_low IS NULL AND direct_member_high IS NULL))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_blocks" (
	"block_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_channels" (
	"channel_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"business_id" uuid NOT NULL,
	"name" text NOT NULL,
	"channel_type" "business_channel_type" DEFAULT 'transactional' NOT NULL,
	"daily_limit_per_subscriber" integer DEFAULT 10 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_channel_daily_limit" CHECK (daily_limit_per_subscriber >= 1 AND daily_limit_per_subscriber <= 100)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_message_deliveries" (
	"delivery_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"message_id" uuid NOT NULL,
	"subscription_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"status" "business_delivery_status" DEFAULT 'pending' NOT NULL,
	"error_message" text,
	"delivered_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_messages" (
	"message_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"channel_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"content" text NOT NULL,
	"template_id" text,
	"total_subscribers" integer DEFAULT 0 NOT NULL,
	"total_delivered" integer DEFAULT 0 NOT NULL,
	"total_failed" integer DEFAULT 0 NOT NULL,
	"status" "business_message_status" DEFAULT 'queued' NOT NULL,
	"scheduled_at" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "business_message_content_len" CHECK (length(trim(content)) >= 1 AND length(content) <= 4096)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "business_subscriptions" (
	"subscription_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"business_id" uuid NOT NULL,
	"channel_id" uuid NOT NULL,
	"status" "business_subscription_status" DEFAULT 'pending' NOT NULL,
	"subscribed_at" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"last_read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "businesses" (
	"business_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"gstin" text,
	"cin" text,
	"category" text NOT NULL,
	"contact_email" text NOT NULL,
	"website" text,
	"logo_url" text,
	"status" "business_status" DEFAULT 'pending' NOT NULL,
	"api_key_hash" text,
	"plan" "business_plan" DEFAULT 'starter' NOT NULL,
	"rejection_reason" text,
	"verified_handle" text,
	"entity_kyc_ref" text,
	"verified_at" timestamp with time zone,
	"suspended_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "businesses_gstin_format" CHECK (gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$')
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payout_methods" (
	"method_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"type" "payout_method_type" NOT NULL,
	"details_masked" text NOT NULL,
	"holder_name" text,
	"verified" boolean DEFAULT false NOT NULL,
	"fund_account_ref" text,
	"razorpay_contact_ref" text,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "payouts" (
	"payout_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"method_id" uuid,
	"razorpayx_ref" text,
	"status" text DEFAULT 'requested' NOT NULL,
	"failure_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "payouts_amount_positive" CHECK (amount_paise > 0),
	CONSTRAINT "payouts_status_check" CHECK (status IN ('requested','processing','paid','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_audit_events" (
	"event_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referral_id" uuid,
	"user_id" uuid,
	"action" text NOT NULL,
	"from_status" text,
	"to_status" text,
	"meta" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_codes" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"code" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_codes_code_unique" UNIQUE("code")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_ledger" (
	"entry_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"amount_paise" integer NOT NULL,
	"entry_type" "referral_ledger_type" NOT NULL,
	"reference_id" uuid,
	"description" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referral_wallets" (
	"user_id" uuid PRIMARY KEY NOT NULL,
	"total_earned_paise" integer DEFAULT 0 NOT NULL,
	"withdrawable_paise" integer DEFAULT 0 NOT NULL,
	"pending_paise" integer DEFAULT 0 NOT NULL,
	"withdrawal_unlocked" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referral_wallet_nonneg" CHECK (total_earned_paise >= 0 AND withdrawable_paise >= 0 AND pending_paise >= 0)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "referrals" (
	"referral_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"referrer_id" uuid NOT NULL,
	"referred_id" uuid NOT NULL,
	"code" text NOT NULL,
	"status" "referral_status" DEFAULT 'invited' NOT NULL,
	"milestones" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"qualified_at" timestamp with time zone,
	"rejected_reason" text,
	"reward_paise" integer DEFAULT 3000 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "referrals_referred_id_unique" UNIQUE("referred_id")
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "admin_actions" (
	"action_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"target_id" uuid,
	"action" text NOT NULL,
	"admin_ref" text,
	"note" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "user_reports" (
	"report_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"reporter_id" uuid NOT NULL,
	"reported_user_id" uuid,
	"reported_number_e164" text,
	"reason_type" "report_reason_type" NOT NULL,
	"note" text,
	"context_type" "report_context_type",
	"context_id" text,
	"signal_weight" numeric(4, 2) DEFAULT '1.00' NOT NULL,
	"block_also" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_reports_subject_check" CHECK (reported_user_id IS NOT NULL OR reported_number_e164 IS NOT NULL)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "data_export_requests" (
	"request_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"status" text DEFAULT 'requested' NOT NULL,
	"email" text,
	"download_url" text,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "data_export_status_check" CHECK (status IN ('requested','processing','ready','failed','expired'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "feature_flags" (
	"key" text PRIMARY KEY NOT NULL,
	"value" jsonb DEFAULT 'true'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "handle_propagation_jobs" (
	"job_id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"old_handle" text NOT NULL,
	"new_handle" text NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"connections_updated" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "handle_propagation_status_check" CHECK (status IN ('pending','processing','done','failed'))
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_contact_messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"message" text NOT NULL,
	"source" text,
	"page" text,
	"user_agent" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "website_waitlist_signups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"email" text NOT NULL,
	"interest_level" smallint NOT NULL,
	"why_better" text NOT NULL,
	"why_willing" text NOT NULL,
	"source" text,
	"page" text,
	"user_agent" text,
	"ip_hash" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "waitlist_interest_range" CHECK (interest_level BETWEEN 1 AND 5)
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_appeals" ADD CONSTRAINT "account_appeals_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "account_appeals" ADD CONSTRAINT "account_appeals_identity_id_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "identities" ADD CONSTRAINT "identities_current_user_id_users_user_id_fk" FOREIGN KEY ("current_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_identity_id_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "onboarding_sessions" ADD CONSTRAINT "onboarding_sessions_matched_user_id_users_user_id_fk" FOREIGN KEY ("matched_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "device_registrations" ADD CONSTRAINT "device_registrations_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "refresh_tokens" ADD CONSTRAINT "refresh_tokens_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "users" ADD CONSTRAINT "users_identity_id_identities_identity_id_fk" FOREIGN KEY ("identity_id") REFERENCES "public"."identities"("identity_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dialer_observations" ADD CONSTRAINT "dialer_observations_observer_id_users_user_id_fk" FOREIGN KEY ("observer_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trust_factors" ADD CONSTRAINT "trust_factors_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "trust_score_history" ADD CONSTRAINT "trust_score_history_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_owner_id_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "connections" ADD CONSTRAINT "connections_contact_id_users_user_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_usage_log" ADD CONSTRAINT "channel_usage_log_channel_id_reachability_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."reachability_channels"("channel_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "channel_usage_log" ADD CONSTRAINT "channel_usage_log_caller_id_users_user_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "contact_shares" ADD CONSTRAINT "contact_shares_owner_id_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "reachability_channels" ADD CONSTRAINT "reachability_channels_owner_id_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "share_events" ADD CONSTRAINT "share_events_share_id_contact_shares_share_id_fk" FOREIGN KEY ("share_id") REFERENCES "public"."contact_shares"("share_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "share_events" ADD CONSTRAINT "share_events_scanner_id_users_user_id_fk" FOREIGN KEY ("scanner_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "behavior_events" ADD CONSTRAINT "behavior_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "behavior_events" ADD CONSTRAINT "behavior_events_target_user_id_users_user_id_fk" FOREIGN KEY ("target_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_quality_reports" ADD CONSTRAINT "call_quality_reports_call_id_calls_call_id_fk" FOREIGN KEY ("call_id") REFERENCES "public"."calls"("call_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "call_quality_reports" ADD CONSTRAINT "call_quality_reports_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_caller_id_users_user_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_callee_id_users_user_id_fk" FOREIGN KEY ("callee_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "calls" ADD CONSTRAINT "calls_channel_id_reachability_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."reachability_channels"("channel_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "masked_calls" ADD CONSTRAINT "masked_calls_caller_id_users_user_id_fk" FOREIGN KEY ("caller_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payment_orders" ADD CONSTRAINT "payment_orders_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "privacy_subscriptions" ADD CONSTRAINT "privacy_subscriptions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallet_transactions" ADD CONSTRAINT "wallet_transactions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "wallets" ADD CONSTRAINT "wallets_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_member_low_users_user_id_fk" FOREIGN KEY ("member_low") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_channels" ADD CONSTRAINT "chat_channels_member_high_users_user_id_fk" FOREIGN KEY ("member_high") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_message_log" ADD CONSTRAINT "chat_message_log_sender_id_users_user_id_fk" FOREIGN KEY ("sender_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "chat_message_log" ADD CONSTRAINT "chat_message_log_recipient_id_users_user_id_fk" FOREIGN KEY ("recipient_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_channels" ADD CONSTRAINT "group_channels_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_members" ADD CONSTRAINT "group_members_group_id_group_channels_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group_channels"("group_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "group_members" ADD CONSTRAINT "group_members_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "media_assets" ADD CONSTRAINT "media_assets_owner_id_users_user_id_fk" FOREIGN KEY ("owner_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_status_updates" ADD CONSTRAINT "user_status_updates_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_activity_id_activity_sessions_activity_id_fk" FOREIGN KEY ("activity_id") REFERENCES "public"."activity_sessions"("activity_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_participants" ADD CONSTRAINT "activity_participants_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_direct_member_low_users_user_id_fk" FOREIGN KEY ("direct_member_low") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_direct_member_high_users_user_id_fk" FOREIGN KEY ("direct_member_high") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_group_id_group_channels_group_id_fk" FOREIGN KEY ("group_id") REFERENCES "public"."group_channels"("group_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_host_user_id_users_user_id_fk" FOREIGN KEY ("host_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_controller_user_id_users_user_id_fk" FOREIGN KEY ("controller_user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_presenter_user_id_users_user_id_fk" FOREIGN KEY ("presenter_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "activity_sessions" ADD CONSTRAINT "activity_sessions_created_by_users_user_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_blocks" ADD CONSTRAINT "business_blocks_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_blocks" ADD CONSTRAINT "business_blocks_business_id_businesses_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("business_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_channels" ADD CONSTRAINT "business_channels_business_id_businesses_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("business_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_message_deliveries" ADD CONSTRAINT "business_message_deliveries_message_id_business_messages_message_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."business_messages"("message_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_message_deliveries" ADD CONSTRAINT "business_message_deliveries_subscription_id_business_subscriptions_subscription_id_fk" FOREIGN KEY ("subscription_id") REFERENCES "public"."business_subscriptions"("subscription_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_message_deliveries" ADD CONSTRAINT "business_message_deliveries_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_channel_id_business_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."business_channels"("channel_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_messages" ADD CONSTRAINT "business_messages_business_id_businesses_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("business_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_reports" ADD CONSTRAINT "business_reports_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_reports" ADD CONSTRAINT "business_reports_business_id_businesses_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("business_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_business_id_businesses_business_id_fk" FOREIGN KEY ("business_id") REFERENCES "public"."businesses"("business_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "business_subscriptions" ADD CONSTRAINT "business_subscriptions_channel_id_business_channels_channel_id_fk" FOREIGN KEY ("channel_id") REFERENCES "public"."business_channels"("channel_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payout_methods" ADD CONSTRAINT "payout_methods_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payouts" ADD CONSTRAINT "payouts_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "payouts" ADD CONSTRAINT "payouts_method_id_payout_methods_method_id_fk" FOREIGN KEY ("method_id") REFERENCES "public"."payout_methods"("method_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_audit_events" ADD CONSTRAINT "referral_audit_events_referral_id_referrals_referral_id_fk" FOREIGN KEY ("referral_id") REFERENCES "public"."referrals"("referral_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_audit_events" ADD CONSTRAINT "referral_audit_events_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_codes" ADD CONSTRAINT "referral_codes_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_ledger" ADD CONSTRAINT "referral_ledger_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referral_wallets" ADD CONSTRAINT "referral_wallets_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referrer_id_users_user_id_fk" FOREIGN KEY ("referrer_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "referrals" ADD CONSTRAINT "referrals_referred_id_users_user_id_fk" FOREIGN KEY ("referred_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "admin_actions" ADD CONSTRAINT "admin_actions_target_id_users_user_id_fk" FOREIGN KEY ("target_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reporter_id_users_user_id_fk" FOREIGN KEY ("reporter_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "user_reports" ADD CONSTRAINT "user_reports_reported_user_id_users_user_id_fk" FOREIGN KEY ("reported_user_id") REFERENCES "public"."users"("user_id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "data_export_requests" ADD CONSTRAINT "data_export_requests_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "handle_propagation_jobs" ADD CONSTRAINT "handle_propagation_jobs_user_id_users_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("user_id") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_appeals_identity" ON "account_appeals" USING btree ("identity_id","created_at" DESC NULLS LAST) WHERE identity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_appeals_user" ON "account_appeals" USING btree ("user_id","created_at" DESC NULLS LAST) WHERE user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_account_appeals_status" ON "account_appeals" USING btree ("status","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_identities_status" ON "identities" USING btree ("status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_identities_current_user" ON "identities" USING btree ("current_user_id") WHERE current_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_onboarding_sessions_expires" ON "onboarding_sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_onboarding_sessions_identity" ON "onboarding_sessions" USING btree ("identity_id") WHERE identity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devices_user" ON "device_registrations" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devices_hardware_id" ON "device_registrations" USING btree ("hardware_id") WHERE hardware_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devices_fingerprint" ON "device_registrations" USING btree ("device_fingerprint") WHERE device_fingerprint IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_devices_push_token" ON "device_registrations" USING btree ("user_id") WHERE push_token IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_device_user_hardware" ON "device_registrations" USING btree ("user_id","hardware_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_user" ON "refresh_tokens" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_refresh_tokens_active" ON "refresh_tokens" USING btree ("token_hash") WHERE revoked = FALSE;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_phone_hash" ON "users" USING btree ("phone_hash") WHERE phone_hash IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_handle" ON "users" USING btree ("handle");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_identity" ON "users" USING btree ("identity_id") WHERE identity_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_account_status" ON "users" USING btree ("account_status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_last_seen" ON "users" USING btree ("last_seen_at" DESC NULLS LAST) WHERE last_seen_at IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_under_review" ON "users" USING btree ("is_under_review") WHERE is_under_review = TRUE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_users_monitored" ON "users" USING btree ("user_id") WHERE is_monitored = TRUE AND is_active = TRUE;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_users_active_identity" ON "users" USING btree ("identity_id") WHERE identity_id IS NOT NULL AND account_status IN ('active','under_review','restricted','suspended');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_obs_phone_recent" ON "dialer_observations" USING btree ("phone_hash","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_obs_observer" ON "dialer_observations" USING btree ("observer_id","observed_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_obs_dedup" ON "dialer_observations" USING btree ("observer_id","phone_hash",date_trunc('hour', observed_at AT TIME ZONE 'UTC'));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_shadow_score" ON "shadow_numbers" USING btree ("shadow_score") WHERE observation_count >= 5;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trust_factors_user" ON "trust_factors" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trust_factors_type" ON "trust_factors" USING btree ("user_id","factor_type");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_trust_factors_user_type_latest" ON "trust_factors" USING btree ("user_id","factor_type") WHERE is_latest = TRUE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trust_factors_completed" ON "trust_factors" USING btree ("user_id","factor_type","status") WHERE status = 'completed' AND is_latest = TRUE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_trust_history_user" ON "trust_score_history" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_connections_owner_contact" ON "connections" USING btree ("owner_id","contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connections_owner" ON "connections" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connections_contact" ON "connections" USING btree ("contact_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_connections_owner_contact_type" ON "connections" USING btree ("owner_id","contact_id","connection_type");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channel_usage" ON "channel_usage_log" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_shares_owner_active" ON "contact_shares" USING btree ("owner_id","active","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_contact_shares_token_active" ON "contact_shares" USING btree ("token") WHERE active = TRUE;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channels_owner" ON "reachability_channels" USING btree ("owner_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_channels_token" ON "reachability_channels" USING btree ("token");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_share_events_share" ON "share_events" USING btree ("share_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_behavior_events_user" ON "behavior_events" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_behavior_events_type" ON "behavior_events" USING btree ("event_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_behavior_events_outreach" ON "behavior_events" USING btree ("user_id","event_type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "call_quality_reports_call_user_uniq" ON "call_quality_reports" USING btree ("call_id","user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calls_caller" ON "calls" USING btree ("caller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calls_callee" ON "calls" USING btree ("callee_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_calls_open" ON "calls" USING btree ("callee_id","status") WHERE status IN ('initiated','ringing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_masked_reports_call_ref" ON "masked_call_reports" USING btree ("call_ref");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_masked_calls_caller" ON "masked_calls" USING btree ("caller_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_masked_calls_landing" ON "masked_calls" USING btree ("landing_token") WHERE landing_token IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payment_orders_user" ON "payment_orders" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_wallet_txn_ref_unique" ON "wallet_transactions" USING btree ("ref") WHERE ref IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_wallet_txn_user_created" ON "wallet_transactions" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_chat_channels_pair" ON "chat_channels" USING btree ("member_low","member_high");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_channels_low" ON "chat_channels" USING btree ("member_low");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_channels_high" ON "chat_channels" USING btree ("member_high");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_msg_sender_recipient" ON "chat_message_log" USING btree ("sender_id","recipient_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_chat_msg_channel" ON "chat_message_log" USING btree ("channel_cid","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_channels_creator" ON "group_channels" USING btree ("created_by");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_group_members_user_id" ON "group_members" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_status_user_expires" ON "user_status_updates" USING btree ("user_id","expires_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_status_expires" ON "user_status_updates" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_participants_user" ON "activity_participants" USING btree ("user_id","left_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_sessions_direct" ON "activity_sessions" USING btree ("direct_member_low","direct_member_high","status","created_at" DESC NULLS LAST) WHERE scope_type = 'direct';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_activity_sessions_group" ON "activity_sessions" USING btree ("group_id","status","created_at" DESC NULLS LAST) WHERE scope_type = 'group';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_active_direct_session" ON "activity_sessions" USING btree ("direct_member_low","direct_member_high") WHERE scope_type = 'direct' AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_one_active_group_session" ON "activity_sessions" USING btree ("group_id") WHERE scope_type = 'group' AND status = 'active';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "uq_business_blocks_user_biz" ON "business_blocks" USING btree ("user_id","business_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_blocks_user" ON "business_blocks" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_channels_business" ON "business_channels" USING btree ("business_id");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_deliveries_message_sub" ON "business_message_deliveries" USING btree ("message_id","subscription_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_deliveries_message" ON "business_message_deliveries" USING btree ("message_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_messages_channel_created" ON "business_messages" USING btree ("channel_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_reports_biz" ON "business_reports" USING btree ("business_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "business_subscriptions_user_channel" ON "business_subscriptions" USING btree ("user_id","channel_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_subscriptions_channel_status" ON "business_subscriptions" USING btree ("channel_id","status");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_business_subscriptions_user" ON "business_subscriptions" USING btree ("user_id","status");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_businesses_gstin" ON "businesses" USING btree ("gstin") WHERE gstin IS NOT NULL AND status != 'rejected';--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_businesses_verified_handle" ON "businesses" USING btree ("verified_handle") WHERE verified_handle IS NOT NULL AND status = 'verified';--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payout_methods_user" ON "payout_methods" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_payouts_user" ON "payouts" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referral_audit_referral" ON "referral_audit_events" USING btree ("referral_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "idx_referral_codes_code_upper" ON "referral_codes" USING btree (upper("code"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referral_ledger_user" ON "referral_ledger" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referrals_referrer" ON "referrals" USING btree ("referrer_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_referrals_status" ON "referrals" USING btree ("status","updated_at");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_actions_target" ON "admin_actions" USING btree ("target_id","created_at" DESC NULLS LAST) WHERE target_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_actions_type" ON "admin_actions" USING btree ("action","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_admin_actions_recent" ON "admin_actions" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_target_user" ON "user_reports" USING btree ("reported_user_id","created_at" DESC NULLS LAST) WHERE reported_user_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_target_number" ON "user_reports" USING btree ("reported_number_e164","created_at" DESC NULLS LAST) WHERE reported_number_e164 IS NOT NULL;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_user_reports_reporter" ON "user_reports" USING btree ("reporter_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_data_export_user" ON "data_export_requests" USING btree ("user_id","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "idx_handle_propagation_pending" ON "handle_propagation_jobs" USING btree ("status","created_at") WHERE status IN ('pending','processing');--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_contact_messages_created_at_idx" ON "website_contact_messages" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_contact_messages_email_idx" ON "website_contact_messages" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_waitlist_signups_created_at_idx" ON "website_waitlist_signups" USING btree ("created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_waitlist_signups_email_idx" ON "website_waitlist_signups" USING btree (lower("email"));--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "website_waitlist_signups_interest_idx" ON "website_waitlist_signups" USING btree ("interest_level");