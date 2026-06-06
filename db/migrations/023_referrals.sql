-- Refer & Earn: codes, wallet, ledger, events, withdrawals

CREATE TYPE referral_ledger_type AS ENUM (
  'referrer_bonus',
  'referee_bonus',
  'pending_to_withdrawable',
  'withdrawal',
  'reversal'
);

CREATE TABLE IF NOT EXISTS referral_codes (
  user_id     UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  code        TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_codes_code_upper
  ON referral_codes (UPPER(code));

CREATE TABLE IF NOT EXISTS referral_wallets (
  user_id               UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  total_earned_paise    INTEGER NOT NULL DEFAULT 0 CHECK (total_earned_paise >= 0),
  withdrawable_paise    INTEGER NOT NULL DEFAULT 0 CHECK (withdrawable_paise >= 0),
  pending_paise         INTEGER NOT NULL DEFAULT 0 CHECK (pending_paise >= 0),
  withdrawal_unlocked   BOOLEAN NOT NULL DEFAULT FALSE,
  updated_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS referral_events (
  event_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  referrer_user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  referee_user_id       UUID NOT NULL UNIQUE REFERENCES users(user_id) ON DELETE CASCADE,
  referral_code         TEXT NOT NULL,
  referrer_bonus_paise  INTEGER NOT NULL DEFAULT 3000,
  referee_bonus_paise   INTEGER NOT NULL DEFAULT 2000,
  status                TEXT NOT NULL DEFAULT 'credited'
                        CHECK (status IN ('credited', 'reversed')),
  created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_events_referrer
  ON referral_events (referrer_user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_ledger (
  entry_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount_paise  INTEGER NOT NULL,
  entry_type    referral_ledger_type NOT NULL,
  reference_id  UUID,
  description   TEXT,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_ledger_user
  ON referral_ledger (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS referral_withdrawals (
  withdrawal_id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id       UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  amount_paise  INTEGER NOT NULL CHECK (amount_paise > 0),
  upi_id        TEXT NOT NULL,
  status        TEXT NOT NULL DEFAULT 'requested'
                CHECK (status IN ('requested', 'processing', 'paid', 'failed')),
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_referral_withdrawals_user
  ON referral_withdrawals (user_id, created_at DESC);
