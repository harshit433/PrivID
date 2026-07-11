-- Phase 3: Masked calling · Wallet · Payments

-- ─── Enums ────────────────────────────────────────────────────────────────────
DO $$ BEGIN
  CREATE TYPE wallet_txn_type AS ENUM (
    'topup', 'hold', 'debit', 'release', 'refund', 'referral_credit', 'adjustment'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE wallet_txn_status AS ENUM ('pending', 'completed', 'failed', 'reversed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payment_order_status AS ENUM ('created', 'paid', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE privacy_sub_status AS ENUM ('none', 'active', 'cancelled', 'past_due');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE masked_call_status AS ENUM (
    'placing', 'ringing_caller', 'ringing_callee', 'connected', 'ended', 'failed', 'cancelled'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE number_pool_status AS ENUM ('active', 'quarantined');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- ─── Wallets ──────────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS wallets (
  user_id       UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  balance_paise BIGINT NOT NULL DEFAULT 0 CHECK (balance_paise >= 0),
  auto_recharge_enabled BOOLEAN NOT NULL DEFAULT FALSE,
  auto_recharge_pack_id TEXT,
  auto_recharge_threshold_paise BIGINT,
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS wallet_transactions (
  txn_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type          wallet_txn_type NOT NULL,
  amount_paise  BIGINT NOT NULL,
  minutes       INT,
  ref           TEXT,
  status        wallet_txn_status NOT NULL DEFAULT 'completed',
  balance_after BIGINT,
  meta          JSONB NOT NULL DEFAULT '{}',
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_wallet_txn_ref_unique
  ON wallet_transactions (ref) WHERE ref IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_wallet_txn_user_created
  ON wallet_transactions (user_id, created_at DESC);

-- ─── Payment orders (Razorpay) ────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS payment_orders (
  order_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  razorpay_order_id TEXT NOT NULL UNIQUE,
  amount_paise      BIGINT NOT NULL,
  pack_id           TEXT NOT NULL,
  status            payment_order_status NOT NULL DEFAULT 'created',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  paid_at           TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_payment_orders_user
  ON payment_orders (user_id, created_at DESC);

-- ─── Privacy Pack subscriptions ───────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS privacy_subscriptions (
  user_id           UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  plan              TEXT NOT NULL DEFAULT 'privacy_pack',
  status            privacy_sub_status NOT NULL DEFAULT 'none',
  minutes_included  INT NOT NULL DEFAULT 0,
  renews_at         TIMESTAMPTZ,
  razorpay_sub_id   TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Virtual number pool ──────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS number_pool (
  virtual_number  TEXT PRIMARY KEY,
  provider        TEXT NOT NULL DEFAULT 'exotel',
  status          number_pool_status NOT NULL DEFAULT 'active',
  assigned_ref    TEXT,
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- ─── Masked calls ─────────────────────────────────────────────────────────────
CREATE TABLE IF NOT EXISTS masked_calls (
  call_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  caller_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  callee_number_hash TEXT NOT NULL,
  callee_display    TEXT,
  virtual_number    TEXT,
  provider_ref      TEXT UNIQUE,
  landing_token     TEXT UNIQUE,
  status            masked_call_status NOT NULL DEFAULT 'placing',
  hold_paise        BIGINT NOT NULL DEFAULT 0,
  billed_seconds    INT NOT NULL DEFAULT 0,
  cost_paise        BIGINT NOT NULL DEFAULT 0,
  started_at        TIMESTAMPTZ,
  connected_at      TIMESTAMPTZ,
  ended_at          TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_masked_calls_caller
  ON masked_calls (caller_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_masked_calls_landing
  ON masked_calls (landing_token) WHERE landing_token IS NOT NULL;

-- ─── Masked call reports (public landing) ─────────────────────────────────────
CREATE TABLE IF NOT EXISTS masked_call_reports (
  report_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  virtual_number TEXT,
  call_ref       TEXT,
  reason         TEXT NOT NULL DEFAULT 'unwanted',
  reporter_hash  TEXT,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_masked_reports_call_ref
  ON masked_call_reports (call_ref);

-- ─── Feature flags / config (seed defaults) ───────────────────────────────────
CREATE TABLE IF NOT EXISTS feature_flags (
  key         TEXT PRIMARY KEY,
  value       JSONB NOT NULL DEFAULT 'true',
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

INSERT INTO feature_flags (key, value) VALUES
  ('masked_calling_enabled', 'true'),
  ('telephony_provider_up', 'true'),
  ('per_minute_rate_paise', '70'),
  ('masked_daily_free_calls', '3'),
  ('masked_hold_minutes', '5')
ON CONFLICT (key) DO NOTHING;

-- Seed dev virtual numbers if pool empty
INSERT INTO number_pool (virtual_number, provider, status)
SELECT v, 'mock', 'active'
FROM (VALUES ('+918000000001'), ('+918000000002'), ('+918000000003')) AS t(v)
ON CONFLICT (virtual_number) DO NOTHING;
