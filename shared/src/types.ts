// ─── Auth ────────────────────────────────────────────────────────────────────

export type TrustTier = 'anonymous' | 'basic' | 'verified' | 'premium';
export type ConnectionType = 'unknown' | 'temporary' | 'trusted' | 'blocked';
export type CallType = 'direct' | 'reachability';
export type CallStatus = 'initiated' | 'ringing' | 'answered' | 'ended' | 'missed' | 'declined' | 'failed';
export type VerificationStatus = 'pending' | 'completed' | 'failed' | 'expired';
export type ChannelStatus = 'active' | 'expired' | 'revoked';
export type IdentityStatus = 'active' | 'self_deleted' | 'suspended' | 'banned' | 'ousted';
export type AccountStatus = 'active' | 'under_review' | 'restricted' | 'suspended' | 'banned' | 'ousted' | 'self_deleted';
export type AppealStatus = 'submitted' | 'in_review' | 'restored' | 'upheld' | 'rejected';

// ─── JWT Payload ──────────────────────────────────────────────────────────────

export interface AccessTokenPayload {
  sub: string;        // user UUID
  handle: string;
  tier: TrustTier;
  iat: number;
  exp: number;
}

// ─── DB Row Types ─────────────────────────────────────────────────────────────

export interface UserRow {
  user_id: string;
  identity_id: string | null;
  phone_e164: string | null;
  phone_hash: string | null;
  handle: string;
  display_name: string | null;
  avatar_url: string | null;
  trust_tier: TrustTier;
  trust_score: number;
  email: string | null;
  profession: string | null;
  bio: string | null;
  business_info: string | null;
  is_active: boolean;
  onboarding_complete: boolean;
  discovery_mode: 'public' | 'private';
  is_under_review: boolean;
  review_reason: string | null;
  review_started_at: Date | null;
  call_restriction_until: Date | null;
  is_monitored: boolean;
  warning_count: number;
  account_status: AccountStatus;
  account_status_reason: string | null;
  account_status_updated_at: Date;
  deleted_at: Date | null;
  suspended_at: Date | null;
  banned_at: Date | null;
  legal_name: string | null;
  kyc_status: 'none' | 'pending' | 'verified' | string;
  kyc_provider: string | null;
  kyc_doc_hash: string | null;
  kyc_verified_at: Date | null;
  /** bcrypt hash of 6-digit account login PIN; never expose to clients */
  pin_hash?: string | null;
  pin_set_at?: Date | null;
  pin_failed_attempts?: number;
  pin_locked_until?: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface IdentityRow {
  identity_id: string;
  legal_name: string;
  doc_type: string;
  doc_hash: string;
  provider: string;
  provider_ref: string | null;
  face_ref: string | null;
  status: IdentityStatus;
  current_user_id: string | null;
  last_handle: string | null;
  status_reason: string | null;
  banned_reason: string | null;
  deleted_at: Date | null;
  suspended_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface OnboardingSessionRow {
  session_id: string;
  purpose: 'signup' | 'recovery' | 'pin_reset';
  status: string;
  device_fingerprint_hash: string | null;
  integrity_verdict: Record<string, unknown>;
  digilocker_provider_ref: string | null;
  liveness_provider_ref: string | null;
  legal_name: string | null;
  doc_type: string | null;
  doc_hash: string | null;
  identity_id: string | null;
  matched_user_id: string | null;
  branch: 'new' | 'self_deleted' | 'active' | 'suspended' | 'banned' | 'ousted' | 'no_match' | null;
  selected_handle: string | null;
  pending_display_name: string | null;
  doc_photo_b64: string | null;
  selfie_b64: string | null;
  expires_at: Date;
  completed_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface AccountAppealRow {
  appeal_id: string;
  user_id: string | null;
  identity_id: string | null;
  status: AppealStatus;
  reason: string;
  evidence: string | null;
  resolution: string | null;
  resolved_by: string | null;
  resolved_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

export interface ConnectionRow {
  connection_id: string;
  owner_id: string;
  contact_id: string;
  connection_type: ConnectionType;
  temporary_expires_at: Date | null;
  daily_call_limit: number | null;
  contact_name: string | null;
  created_at: Date;
  updated_at: Date;
}

export interface OtpSessionRow {
  session_id: string;
  phone_e164: string;
  otp_hash: string;
  attempts: number;
  expires_at: Date;
  verified: boolean;
  created_at: Date;
}

export interface RefreshTokenRow {
  token_id: string;
  user_id: string;
  token_hash: string;
  expires_at: Date;
  revoked: boolean;
  created_at: Date;
}

export interface ReachabilityChannelRow {
  channel_id: string;
  owner_id: string;
  token: string;
  label: string | null;
  status: ChannelStatus;
  daily_limit: number;
  total_limit: number | null;
  use_count: number;
  expires_at: Date | null;
  created_at: Date;
  updated_at: Date;
}

/** Extended type for the /channels/resolve/:token endpoint (JOIN with users). */
export interface ReachabilityChannelPublic extends ReachabilityChannelRow {
  handle: string;
  display_name: string | null;
  trust_tier: TrustTier;
}

export interface CallRow {
  call_id: string;
  caller_id: string;
  callee_id: string;
  call_type: CallType;
  status: CallStatus;
  channel_id: string | null;
  webrtc_room_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  decline_reason: string | null;
  created_at: Date;
  updated_at: Date;
}

// ─── Shadow trust ────────────────────────────────────────────────────────────

export interface ShadowNumberRow {
  phone_hash:        string;
  pick_rate:         number;
  declined_rate:     number;
  block_rate:        number;
  save_rate:         number;
  hung_fast_rate:    number;
  observation_count: number;
  shadow_score:      number;    // 0–100; 50 = neutral / insufficient data
  last_updated_at:   Date;
}

export type DialerOutcome =
  | 'picked_up'
  | 'declined'
  | 'blocked'
  | 'saved'
  | 'hung_up_fast'
  | 'incoming_accepted'
  | 'incoming_declined'
  | 'incoming_missed'
  | 'incoming_blocked'
  | 'outgoing_answered'
  | 'outgoing_missed'
  | 'outgoing_declined';

export type DialerDirection = 'incoming' | 'outgoing';

export interface DialerObservationRow {
  obs_id:              string;
  observer_id:         string;
  phone_hash:          string;
  outcome:             DialerOutcome;
  direction:           DialerDirection | null;
  is_contact:          boolean;
  is_trustroute_user:  boolean;
  context_label:       string | null;
  weight:              number;
  duration_s:          number | null;
  observed_at:         Date;
}

// ─── Presence ─────────────────────────────────────────────────────────────────

export type PresenceStatus = 'online' | 'away' | 'offline';

export interface UserPresence {
  user_id:      string;
  status:       PresenceStatus;
  last_seen_at: Date | null;
  status_text:  string | null;
  status_emoji: string | null;
}

/** Derive presence tier from last_seen_at (computed at query time). */
export function derivePresence(lastSeenAt: Date | null): PresenceStatus {
  if (!lastSeenAt) return 'offline';
  const diffMs = Date.now() - new Date(lastSeenAt).getTime();
  if (diffMs < 3 * 60 * 1_000)  return 'online';
  if (diffMs < 30 * 60 * 1_000) return 'away';
  return 'offline';
}

// ─── Call quality ─────────────────────────────────────────────────────────────

export interface CallQualityReport {
  report_id:       string;
  call_id:         string;
  user_id:         string;
  mos_score:       number | null;   // Mean Opinion Score 1.0–5.0
  packet_loss_pct: number | null;
  jitter_ms:       number | null;
  rtt_ms:          number | null;
  created_at:      Date;
}

// ─── API Response shapes ──────────────────────────────────────────────────────

export interface ApiOk<T = void> {
  ok: true;
  data: T;
}

export interface ApiError {
  ok: false;
  error: {
    code: string;
    message: string;
  };
}

export type ApiResponse<T = void> = ApiOk<T> | ApiError;

export function ok<T>(data: T): ApiOk<T> {
  return { ok: true, data };
}

export function err(code: string, message: string): ApiError {
  return { ok: false, error: { code, message } };
}
