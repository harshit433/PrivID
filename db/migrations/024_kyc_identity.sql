-- 024_kyc_identity.sql
-- Government-verified identity (DigiLocker/Setu) on the user record.
-- Enables: handle name-lock (handle must derive from the verified legal name),
-- a verified-name badge, and one-identity-one-account de-duplication.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS legal_name       TEXT,
  ADD COLUMN IF NOT EXISTS kyc_status        TEXT NOT NULL DEFAULT 'none',   -- none | pending | verified
  ADD COLUMN IF NOT EXISTS kyc_provider      TEXT,                            -- 'setu'
  ADD COLUMN IF NOT EXISTS kyc_doc_hash      TEXT,                            -- sha256(maskedAadhaar|name|dob); no raw Aadhaar
  ADD COLUMN IF NOT EXISTS kyc_verified_at   TIMESTAMPTZ;

-- One government identity → at most one active account. A different user cannot
-- claim an already-verified identity (the DB-level backstop for dedup; the
-- application also checks and returns a friendly message).
CREATE UNIQUE INDEX IF NOT EXISTS uq_users_kyc_doc_hash
  ON users (kyc_doc_hash)
  WHERE kyc_doc_hash IS NOT NULL;
