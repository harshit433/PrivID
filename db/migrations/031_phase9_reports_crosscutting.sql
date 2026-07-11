-- Phase 9: User reports (trust-weighted signals) + appeal resolution fields

DO $$ BEGIN
  CREATE TYPE report_reason_type AS ENUM (
    'spam_scam', 'harassment', 'impersonation', 'inappropriate', 'other'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE report_context_type AS ENUM (
    'call', 'chat', 'contact', 'profile', 'number', 'business'
  );
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_reports (
  report_id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  reporter_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  reported_user_id     UUID REFERENCES users(user_id) ON DELETE SET NULL,
  reported_number_e164 TEXT,
  reason_type          report_reason_type NOT NULL,
  note                 TEXT,
  context_type         report_context_type,
  context_id           TEXT,
  signal_weight        NUMERIC(4,2) NOT NULL DEFAULT 1.00,
  block_also           BOOLEAN NOT NULL DEFAULT FALSE,
  created_at           TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (reported_user_id IS NOT NULL OR reported_number_e164 IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_user_reports_target_user
  ON user_reports (reported_user_id, created_at DESC)
  WHERE reported_user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_reports_target_number
  ON user_reports (reported_number_e164, created_at DESC)
  WHERE reported_number_e164 IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_user_reports_reporter
  ON user_reports (reporter_id, created_at DESC);

-- Appeal resolution message for APP-02
ALTER TABLE account_appeals
  ADD COLUMN IF NOT EXISTS reviewer_message TEXT;
