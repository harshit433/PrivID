-- TrustRoute Database Schema v1
-- Run in order; each migration is idempotent via IF NOT EXISTS

CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "pg_trgm";

-- ─── Enums ────────────────────────────────────────────────────────────────────

DO $$ BEGIN
  CREATE TYPE trust_tier AS ENUM ('anonymous', 'basic', 'verified', 'premium');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE connection_type AS ENUM ('unknown', 'temporary', 'trusted', 'blocked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE call_status AS ENUM ('initiated', 'ringing', 'answered', 'ended', 'missed', 'declined', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE call_type AS ENUM ('direct', 'reachability');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE channel_status AS ENUM ('active', 'expired', 'revoked');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE verification_status AS ENUM ('pending', 'completed', 'failed', 'expired');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

-- ─── Layer 1: Identity ────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS users (
  user_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      TEXT NOT NULL UNIQUE,
  phone_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 of normalized phone
  handle          TEXT NOT NULL UNIQUE,
  display_name    TEXT,
  avatar_url      TEXT,
  trust_tier      trust_tier NOT NULL DEFAULT 'anonymous',
  trust_score     INTEGER NOT NULL DEFAULT 0 CHECK (trust_score BETWEEN 0 AND 100),
  is_active       BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_users_handle ON users (handle);
CREATE INDEX IF NOT EXISTS idx_users_phone_hash ON users (phone_hash);

CREATE TABLE IF NOT EXISTS otp_sessions (
  session_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  phone_e164      TEXT NOT NULL,
  otp_hash        TEXT NOT NULL,          -- bcrypt hash of 6-digit OTP
  attempts        INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ NOT NULL,
  verified        BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_otp_sessions_phone ON otp_sessions (phone_e164);

CREATE TABLE IF NOT EXISTS refresh_tokens (
  token_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token_hash      TEXT NOT NULL UNIQUE,   -- SHA-256 of opaque token
  device_id       TEXT,
  expires_at      TIMESTAMPTZ NOT NULL,
  revoked         BOOLEAN NOT NULL DEFAULT FALSE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_refresh_tokens_user ON refresh_tokens (user_id);
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_hash ON refresh_tokens (token_hash);

CREATE TABLE IF NOT EXISTS device_registrations (
  device_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  push_token      TEXT,
  platform        TEXT NOT NULL CHECK (platform IN ('ios', 'android')),
  device_pub_key  TEXT,                   -- ECIES public key for reachability token push
  integrity_token TEXT,
  last_seen_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_devices_user ON device_registrations (user_id);

-- ─── Layer 2: Trust ───────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS trust_factors (
  factor_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  factor_type     TEXT NOT NULL,          -- 'phone_verified', 'liveness', 'govt_id', 'play_integrity', etc.
  status          verification_status NOT NULL DEFAULT 'pending',
  provider        TEXT,                   -- 'msg91', 'onfido', 'setu', 'play_integrity'
  provider_ref    TEXT,                   -- external verification ID
  score_delta     INTEGER NOT NULL DEFAULT 0,
  verified_at     TIMESTAMPTZ,
  expires_at      TIMESTAMPTZ,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_factors_user ON trust_factors (user_id);
CREATE INDEX IF NOT EXISTS idx_trust_factors_type ON trust_factors (user_id, factor_type);

CREATE TABLE IF NOT EXISTS trust_score_history (
  history_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  old_score       INTEGER NOT NULL,
  new_score       INTEGER NOT NULL,
  old_tier        trust_tier NOT NULL,
  new_tier        trust_tier NOT NULL,
  reason          TEXT NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_trust_history_user ON trust_score_history (user_id, created_at DESC);

-- ─── Layer 3: Reachability ────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS connections (
  connection_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id              UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  contact_id            UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  connection_type       connection_type NOT NULL DEFAULT 'unknown',
  temporary_expires_at  TIMESTAMPTZ,
  daily_call_limit      INTEGER,
  notes                 TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (owner_id, contact_id)
);

CREATE INDEX IF NOT EXISTS idx_connections_owner ON connections (owner_id);
CREATE INDEX IF NOT EXISTS idx_connections_contact ON connections (contact_id);

CREATE TABLE IF NOT EXISTS reachability_channels (
  channel_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE DEFAULT replace(replace(encode(gen_random_bytes(32), 'base64'), '+', '-'), '/', '_'),
  label           TEXT,
  status          channel_status NOT NULL DEFAULT 'active',
  daily_limit     INTEGER NOT NULL DEFAULT 3,
  total_limit     INTEGER,
  use_count       INTEGER NOT NULL DEFAULT 0,
  expires_at      TIMESTAMPTZ,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channels_owner ON reachability_channels (owner_id);
CREATE INDEX IF NOT EXISTS idx_channels_token ON reachability_channels (token);

CREATE TABLE IF NOT EXISTS channel_usage_log (
  log_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id      UUID NOT NULL REFERENCES reachability_channels(channel_id) ON DELETE CASCADE,
  caller_id       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  action          TEXT NOT NULL,          -- 'call_attempted', 'call_connected', 'limit_hit'
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_channel_usage ON channel_usage_log (channel_id, created_at DESC);

-- ─── Layer 4: Communication ───────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS calls (
  call_id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  callee_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  call_type             call_type NOT NULL DEFAULT 'direct',
  status                call_status NOT NULL DEFAULT 'initiated',
  channel_id            UUID REFERENCES reachability_channels(channel_id) ON DELETE SET NULL,
  webrtc_room_id        TEXT,
  started_at            TIMESTAMPTZ,
  ended_at              TIMESTAMPTZ,
  duration_seconds      INTEGER,
  decline_reason        TEXT,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_calls_caller ON calls (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_callee ON calls (callee_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_calls_status ON calls (status) WHERE status IN ('initiated', 'ringing');

CREATE TABLE IF NOT EXISTS call_quality_reports (
  report_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  call_id         UUID NOT NULL REFERENCES calls(call_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  mos_score       NUMERIC(3,1),           -- Mean Opinion Score 1.0-5.0
  packet_loss_pct NUMERIC(5,2),
  jitter_ms       INTEGER,
  rtt_ms          INTEGER,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS behavior_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  event_type      TEXT NOT NULL,
  target_user_id  UUID REFERENCES users(user_id) ON DELETE SET NULL,
  metadata        JSONB NOT NULL DEFAULT '{}',
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_behavior_events_user ON behavior_events (user_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_behavior_events_type ON behavior_events (event_type, created_at DESC);

-- ─── Triggers: updated_at ─────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION set_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DO $$ BEGIN
  CREATE TRIGGER trg_users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_connections_updated_at BEFORE UPDATE ON connections FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_channels_updated_at BEFORE UPDATE ON reachability_channels FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_calls_updated_at BEFORE UPDATE ON calls FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
