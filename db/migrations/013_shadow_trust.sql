-- 013_shadow_trust.sql
--
-- Shadow Trust Scoring — crowd-sourced reputation for non-TrustRoute numbers.
--
-- Two tables:
--
--   dialer_observations  — raw events recorded when a TrustRoute user's
--                          regular phone dialer encounters an external number.
--                          The mobile app hashes the number (SHA-256) before
--                          sending so the raw phone number never touches the server.
--
--   shadow_numbers       — aggregated reputation per phone hash.  Computed
--                          nightly by the shadowScoreRecompute worker job.
--                          Read at call-time to warn users about suspected spam.
--                          Read at registration to assign a starting score
--                          modifier to newly-joining users.
--
-- Design decisions:
--   • phone_hash is always SHA-256(E.164 phone number) — never raw digits.
--   • Each observation has exactly one outcome (mutually exclusive).
--   • shadow_score baseline is 50 (neutral) and diverges only after >= 5
--     observations so low-data numbers don't get unfairly penalised.
--   • Observations older than 180 days are excluded from recomputation
--     (recent behaviour matters more than old calls).

-- ─── Raw observations ─────────────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS dialer_observations (
  obs_id       UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  observer_id  UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  phone_hash   TEXT        NOT NULL,   -- SHA-256 of normalised E.164 number
  outcome      TEXT        NOT NULL,
  duration_s   INTEGER,                -- seconds; NULL for declined/blocked
  observed_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),

  CONSTRAINT dialer_observations_outcome_check
    CHECK (outcome IN ('picked_up', 'declined', 'blocked', 'saved', 'hung_up_fast'))
);

-- Primary access pattern: aggregate outcomes per phone hash (recent)
CREATE INDEX IF NOT EXISTS idx_obs_phone_recent
  ON dialer_observations (phone_hash, observed_at DESC);

-- Secondary: fetch a user's own observations (privacy audit, dedup)
CREATE INDEX IF NOT EXISTS idx_obs_observer
  ON dialer_observations (observer_id, observed_at DESC);

-- Prevent a single observer from submitting more than one observation
-- for the same number within the same UTC hour (anti-spam).
-- date_trunc(timestamptz) is STABLE (timezone-dependent); AT TIME ZONE 'UTC'
-- yields timestamp without time zone so the expression is IMMUTABLE for indexes.
CREATE UNIQUE INDEX IF NOT EXISTS idx_obs_dedup
  ON dialer_observations (
    observer_id,
    phone_hash,
    date_trunc('hour', observed_at AT TIME ZONE 'UTC')
  );

-- ─── Aggregated shadow scores ─────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS shadow_numbers (
  phone_hash         TEXT        PRIMARY KEY,  -- SHA-256 of E.164
  pick_rate          NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (pick_rate BETWEEN 0 AND 1),
  declined_rate      NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (declined_rate BETWEEN 0 AND 1),
  block_rate         NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (block_rate BETWEEN 0 AND 1),
  save_rate          NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (save_rate BETWEEN 0 AND 1),
  hung_fast_rate     NUMERIC(5,4) NOT NULL DEFAULT 0 CHECK (hung_fast_rate BETWEEN 0 AND 1),
  observation_count  INTEGER      NOT NULL DEFAULT 0,
  shadow_score       INTEGER      NOT NULL DEFAULT 50 CHECK (shadow_score BETWEEN 0 AND 100),
  last_updated_at    TIMESTAMPTZ  NOT NULL DEFAULT NOW()
);

-- Fast lookup when an unknown number calls a TrustRoute user
CREATE INDEX IF NOT EXISTS idx_shadow_score
  ON shadow_numbers (shadow_score)
  WHERE observation_count >= 5;
