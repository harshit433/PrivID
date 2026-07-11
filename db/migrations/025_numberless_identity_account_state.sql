-- 025_numberless_identity_account_state.sql
--
-- Numberless identity rail:
--   - Government identity becomes the durable account anchor.
--   - Phone/SIM becomes an optional verified reachability factor.
--   - Account state is explicit instead of overloaded into users.is_active.
--   - Self-deleted identities can recreate/restore; banned/ousted identities cannot.
--   - Appeals are first-class rows, visible to the app and admin tools.

DO $$ BEGIN
  CREATE TYPE identity_status AS ENUM ('active', 'self_deleted', 'suspended', 'banned', 'ousted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE account_status AS ENUM ('active', 'under_review', 'restricted', 'suspended', 'banned', 'ousted', 'self_deleted');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE appeal_status AS ENUM ('submitted', 'in_review', 'restored', 'upheld', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS identities (
  identity_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  legal_name        TEXT NOT NULL,
  doc_type          TEXT NOT NULL DEFAULT 'aadhaar',
  doc_hash          TEXT NOT NULL UNIQUE,
  provider          TEXT NOT NULL DEFAULT 'setu',
  provider_ref      TEXT,
  face_ref          TEXT,
  status            identity_status NOT NULL DEFAULT 'active',
  current_user_id   UUID,
  last_handle       TEXT,
  status_reason     TEXT,
  banned_reason     TEXT,
  deleted_at        TIMESTAMPTZ,
  suspended_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_identities_status
  ON identities (status);

CREATE INDEX IF NOT EXISTS idx_identities_current_user
  ON identities (current_user_id)
  WHERE current_user_id IS NOT NULL;

ALTER TABLE users
  ALTER COLUMN phone_e164 DROP NOT NULL,
  ALTER COLUMN phone_hash DROP NOT NULL,
  ADD COLUMN IF NOT EXISTS identity_id UUID REFERENCES identities(identity_id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS account_status account_status NOT NULL DEFAULT 'active',
  ADD COLUMN IF NOT EXISTS account_status_reason TEXT,
  ADD COLUMN IF NOT EXISTS account_status_updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ADD COLUMN IF NOT EXISTS deleted_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS banned_at TIMESTAMPTZ;

ALTER TABLE identities
  ADD COLUMN IF NOT EXISTS status_reason TEXT;

-- Government-identity uniqueness now lives on identities.doc_hash. The old
-- user-level index blocks legitimate recreation after a self-delete because
-- historical/tombstoned user rows retain their KYC audit copy.
DROP INDEX IF EXISTS uq_users_kyc_doc_hash;

-- Backfill status for old rows. Deleted accounts were tombstoned by users/me DELETE.
UPDATE users
   SET account_status = CASE
         WHEN is_active = FALSE AND handle LIKE 'deleted_%' THEN 'self_deleted'::account_status
         WHEN is_active = FALSE THEN 'suspended'::account_status
         WHEN is_under_review = TRUE THEN 'under_review'::account_status
         WHEN call_restriction_until IS NOT NULL AND call_restriction_until > NOW() THEN 'restricted'::account_status
         ELSE 'active'::account_status
       END,
       account_status_updated_at = COALESCE(updated_at, NOW())
 WHERE account_status = 'active'
   AND (
     is_active = FALSE
     OR is_under_review = TRUE
     OR (call_restriction_until IS NOT NULL AND call_restriction_until > NOW())
   );

-- Bridge existing KYC-on-user rows into identity rows.
INSERT INTO identities (legal_name, doc_type, doc_hash, provider, status, current_user_id, last_handle, created_at, updated_at)
SELECT COALESCE(NULLIF(TRIM(legal_name), ''), display_name, handle),
       'aadhaar',
       kyc_doc_hash,
       COALESCE(kyc_provider, 'setu'),
       CASE
         WHEN account_status = 'self_deleted' THEN 'self_deleted'::identity_status
         WHEN account_status = 'suspended' THEN 'suspended'::identity_status
         WHEN account_status = 'banned' THEN 'banned'::identity_status
         WHEN account_status = 'ousted' THEN 'ousted'::identity_status
         ELSE 'active'::identity_status
       END,
       CASE WHEN account_status IN ('active','under_review','restricted') THEN user_id ELSE NULL END,
       handle,
       COALESCE(kyc_verified_at, created_at, NOW()),
       NOW()
  FROM users
 WHERE kyc_doc_hash IS NOT NULL
ON CONFLICT (doc_hash) DO UPDATE
  SET current_user_id = COALESCE(identities.current_user_id, EXCLUDED.current_user_id),
      last_handle = COALESCE(EXCLUDED.last_handle, identities.last_handle),
      updated_at = NOW();

UPDATE users u
   SET identity_id = i.identity_id
  FROM identities i
 WHERE u.kyc_doc_hash IS NOT NULL
   AND i.doc_hash = u.kyc_doc_hash
   AND u.identity_id IS NULL;

ALTER TABLE identities
  DROP CONSTRAINT IF EXISTS identities_current_user_fk,
  ADD CONSTRAINT identities_current_user_fk
    FOREIGN KEY (current_user_id) REFERENCES users(user_id) ON DELETE SET NULL;

CREATE INDEX IF NOT EXISTS idx_users_identity
  ON users (identity_id)
  WHERE identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_users_account_status
  ON users (account_status);

CREATE UNIQUE INDEX IF NOT EXISTS uq_users_active_identity
  ON users (identity_id)
  WHERE identity_id IS NOT NULL
    AND account_status IN ('active','under_review','restricted','suspended');

CREATE TABLE IF NOT EXISTS onboarding_sessions (
  session_id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  purpose                 TEXT NOT NULL CHECK (purpose IN ('signup', 'recovery')),
  status                  TEXT NOT NULL DEFAULT 'started'
                          CHECK (status IN ('started','device_checked','digilocker_started','digilocker_verified','liveness_started','liveness_verified','matched','completed','expired')),
  device_fingerprint_hash TEXT,
  integrity_verdict       JSONB NOT NULL DEFAULT '{}',
  digilocker_provider_ref TEXT,
  liveness_provider_ref   TEXT,
  legal_name              TEXT,
  doc_type                TEXT,
  doc_hash                TEXT,
  identity_id             UUID REFERENCES identities(identity_id) ON DELETE SET NULL,
  matched_user_id         UUID REFERENCES users(user_id) ON DELETE SET NULL,
  branch                  TEXT CHECK (branch IS NULL OR branch IN ('new','self_deleted','active','suspended','banned','ousted','no_match')),
  selected_handle         TEXT,
  expires_at              TIMESTAMPTZ NOT NULL DEFAULT NOW() + INTERVAL '20 minutes',
  completed_at            TIMESTAMPTZ,
  created_at              TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at              TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_expires
  ON onboarding_sessions (expires_at);

CREATE INDEX IF NOT EXISTS idx_onboarding_sessions_identity
  ON onboarding_sessions (identity_id)
  WHERE identity_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS account_appeals (
  appeal_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id        UUID REFERENCES users(user_id) ON DELETE SET NULL,
  identity_id    UUID REFERENCES identities(identity_id) ON DELETE SET NULL,
  status         appeal_status NOT NULL DEFAULT 'submitted',
  reason         TEXT NOT NULL,
  evidence       TEXT,
  resolution     TEXT,
  resolved_by    TEXT,
  resolved_at    TIMESTAMPTZ,
  created_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at     TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CHECK (user_id IS NOT NULL OR identity_id IS NOT NULL)
);

CREATE INDEX IF NOT EXISTS idx_account_appeals_identity
  ON account_appeals (identity_id, created_at DESC)
  WHERE identity_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_appeals_user
  ON account_appeals (user_id, created_at DESC)
  WHERE user_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_account_appeals_status
  ON account_appeals (status, created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_identities_updated_at
  BEFORE UPDATE ON identities
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_onboarding_sessions_updated_at
  BEFORE UPDATE ON onboarding_sessions
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TRIGGER trg_account_appeals_updated_at
  BEFORE UPDATE ON account_appeals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
