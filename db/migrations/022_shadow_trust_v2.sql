-- 022_shadow_trust_v2.sql
-- Extend Shadow Trust: richer call outcomes, contact context, user opt-in.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS shadow_trust_enabled BOOLEAN NOT NULL DEFAULT FALSE;

ALTER TABLE dialer_observations
  ADD COLUMN IF NOT EXISTS direction TEXT,
  ADD COLUMN IF NOT EXISTS is_contact BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS is_trustroute_user BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS context_label TEXT,
  ADD COLUMN IF NOT EXISTS weight NUMERIC(4,3) NOT NULL DEFAULT 1.000
    CHECK (weight >= 0 AND weight <= 1);

ALTER TABLE dialer_observations
  DROP CONSTRAINT IF EXISTS dialer_observations_outcome_check;

ALTER TABLE dialer_observations
  ADD CONSTRAINT dialer_observations_direction_check
    CHECK (direction IS NULL OR direction IN ('incoming', 'outgoing'));

ALTER TABLE dialer_observations
  ADD CONSTRAINT dialer_observations_outcome_check
    CHECK (outcome IN (
      'picked_up', 'declined', 'blocked', 'saved', 'hung_up_fast',
      'incoming_accepted', 'incoming_declined', 'incoming_missed', 'incoming_blocked',
      'outgoing_answered', 'outgoing_missed', 'outgoing_declined'
    ));

CREATE INDEX IF NOT EXISTS idx_obs_phone_weighted
  ON dialer_observations (phone_hash, observed_at DESC)
  WHERE weight > 0;
