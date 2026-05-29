// ─── Auth ────────────────────────────────────────────────────────────────────

export type TrustTier = 'anonymous' | 'basic' | 'verified' | 'premium';
export type ConnectionType = 'unknown' | 'temporary' | 'trusted' | 'blocked';
export type CallType = 'direct' | 'reachability';
export type CallStatus = 'initiated' | 'ringing' | 'answered' | 'ended' | 'missed' | 'declined' | 'failed';
export type VerificationStatus = 'pending' | 'completed' | 'failed' | 'expired';
export type ChannelStatus = 'active' | 'expired' | 'revoked';

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
  phone_e164: string;
  handle: string;
  display_name: string | null;
  trust_tier: TrustTier;
  trust_score: number;
  is_active: boolean;
  onboarding_complete: boolean;
  discovery_mode: 'public' | 'private';
  is_under_review: boolean;
  review_reason: string | null;
  review_started_at: Date | null;
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
  expires_at: Date | null;
  created_at: Date;
}

export interface CallRow {
  call_id: string;
  caller_id: string;
  callee_id: string;
  call_type: CallType;
  status: CallStatus;
  channel_id: string | null;
  started_at: Date | null;
  ended_at: Date | null;
  duration_seconds: number | null;
  created_at: Date;
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
