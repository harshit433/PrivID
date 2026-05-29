-- Add unique constraint on (user_id, factor_type) so ON CONFLICT works in trust routes
-- Only one active factor per type per user

ALTER TABLE trust_factors
  ADD COLUMN IF NOT EXISTS is_latest BOOLEAN NOT NULL DEFAULT TRUE;

CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_factors_user_type_latest
  ON trust_factors (user_id, factor_type)
  WHERE is_latest = TRUE;

-- Behavior events index for mass outreach detection
CREATE INDEX IF NOT EXISTS idx_behavior_events_outreach
  ON behavior_events (user_id, event_type, created_at DESC);

-- Partial index for active refresh tokens (fast lookup)
CREATE INDEX IF NOT EXISTS idx_refresh_tokens_active
  ON refresh_tokens (token_hash)
  WHERE revoked = FALSE;

-- Partial index for open calls (signaling server uses this)
CREATE INDEX IF NOT EXISTS idx_calls_open
  ON calls (callee_id, status)
  WHERE status IN ('initiated', 'ringing');
