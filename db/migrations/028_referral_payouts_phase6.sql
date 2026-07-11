-- Phase 6: fraud-resistant referral qualification + RazorpayX payouts

DO $$ BEGIN
  CREATE TYPE referral_status AS ENUM (
    'invited', 'verified', 'qualifying', 'qualified', 'paid', 'rejected'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE payout_method_type AS ENUM ('upi', 'bank');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

-- Extend ledger types
ALTER TYPE referral_ledger_type ADD VALUE IF NOT EXISTS 'earn';
ALTER TYPE referral_ledger_type ADD VALUE IF NOT EXISTS 'payout';
ALTER TYPE referral_ledger_type ADD VALUE IF NOT EXISTS 'convert_to_call';

CREATE TABLE IF NOT EXISTS referrals (
  referral_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  referred_id       UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  code              TEXT NOT NULL,
  status            referral_status NOT NULL DEFAULT 'invited',
  milestones        JSONB NOT NULL DEFAULT '{}'::jsonb,
  qualified_at      TIMESTAMPTZ,
  rejected_reason   TEXT,
  reward_paise      INTEGER NOT NULL DEFAULT 3000,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referrals_referrer ON referrals (referrer_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status, updated_at);

CREATE TABLE IF NOT EXISTS referral_audit_events (
  event_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referral_id   UUID REFERENCES referrals(referral_id) ON DELETE SET NULL,
  user_id       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  action        TEXT NOT NULL,
  from_status   TEXT,
  to_status     TEXT,
  meta          JSONB,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_audit_referral ON referral_audit_events (referral_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payout_methods (
  method_id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id               UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type                  payout_method_type NOT NULL,
  details_masked        TEXT NOT NULL,
  holder_name           TEXT,
  verified              BOOLEAN NOT NULL DEFAULT FALSE,
  fund_account_ref      TEXT,
  razorpay_contact_ref  TEXT,
  is_default            BOOLEAN NOT NULL DEFAULT FALSE,
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payout_methods_user ON payout_methods (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS payouts (
  payout_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount_paise      INTEGER NOT NULL CHECK (amount_paise > 0),
  method_id         UUID REFERENCES payout_methods(method_id),
  razorpayx_ref     TEXT,
  status            TEXT NOT NULL DEFAULT 'requested'
                    CHECK (status IN ('requested', 'processing', 'paid', 'failed')),
  failure_reason    TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_payouts_user ON payouts (user_id, created_at DESC);

-- Backfill from legacy referral_events
INSERT INTO referrals (referrer_id, referred_id, code, status, reward_paise, qualified_at, created_at, milestones)
SELECT
  re.referrer_user_id,
  re.referee_user_id,
  re.referral_code,
  CASE WHEN re.status = 'credited' THEN 'paid'::referral_status ELSE 'rejected'::referral_status END,
  re.referrer_bonus_paise,
  CASE WHEN re.status = 'credited' THEN re.created_at ELSE NULL END,
  re.created_at,
  jsonb_build_object('kyc', true, 'calls', 5, 'active_days', 30, 'legacy', true)
FROM referral_events re
ON CONFLICT (referred_id) DO NOTHING;

-- Feature flags for referral program
INSERT INTO feature_flags (key, value, updated_at) VALUES
  ('referral_reward_paise', '3000', NOW()),
  ('referral_min_calls', '5', NOW()),
  ('referral_active_days', '30', NOW()),
  ('referral_min_withdrawal_paise', '10000', NOW()),
  ('referral_max_per_day', '10', NOW()),
  ('referral_max_per_week', '30', NOW()),
  ('razorpayx_enabled', 'true', NOW()),
  ('referral_invite_base_url', '"https://trustroute.app/invite"', NOW())
ON CONFLICT (key) DO NOTHING;
