-- Phase 7: Settings · Profile · Account

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS organisation VARCHAR(120),
  ADD COLUMN IF NOT EXISTS address TEXT,
  ADD COLUMN IF NOT EXISTS language_pref VARCHAR(10) NOT NULL DEFAULT 'en',
  ADD COLUMN IF NOT EXISTS handle_changed_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS discovery_contact_book_matching BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS discovery_show_trust_score BOOLEAN NOT NULL DEFAULT TRUE,
  ADD COLUMN IF NOT EXISTS notification_prefs JSONB NOT NULL DEFAULT '{
    "calls": true,
    "messages": true,
    "group_messages": true,
    "company_updates": true,
    "referral": true,
    "trust_security": true,
    "sound": true,
    "vibrate": true
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS user_consents JSONB NOT NULL DEFAULT '{
    "kyc_use": true,
    "analytics_opt_out": false
  }'::jsonb,
  ADD COLUMN IF NOT EXISTS purge_scheduled_at TIMESTAMPTZ;

CREATE TABLE IF NOT EXISTS data_export_requests (
  request_id   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status       TEXT NOT NULL DEFAULT 'requested'
               CHECK (status IN ('requested', 'processing', 'ready', 'failed', 'expired')),
  email        TEXT,
  download_url TEXT,
  expires_at   TIMESTAMPTZ,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_data_export_user ON data_export_requests (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS handle_propagation_jobs (
  job_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id             UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  old_handle          TEXT NOT NULL,
  new_handle          TEXT NOT NULL,
  status              TEXT NOT NULL DEFAULT 'pending'
                      CHECK (status IN ('pending', 'processing', 'done', 'failed')),
  connections_updated INT NOT NULL DEFAULT 0,
  created_at          TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  completed_at        TIMESTAMPTZ
);

CREATE INDEX IF NOT EXISTS idx_handle_propagation_pending
  ON handle_propagation_jobs (status, created_at)
  WHERE status IN ('pending', 'processing');

INSERT INTO feature_flags (key, value) VALUES
  ('handle_change_cooldown_days', '30'),
  ('data_export_sla_hours', '72')
ON CONFLICT (key) DO NOTHING;
