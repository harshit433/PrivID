-- Phase 8: Verified business identity + user↔business bridge extensions

ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS verified_handle TEXT,
  ADD COLUMN IF NOT EXISTS entity_kyc_ref TEXT;

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_verified_handle
  ON businesses (verified_handle)
  WHERE verified_handle IS NOT NULL AND status = 'verified';

-- Backfill verified_handle from name for existing verified businesses
UPDATE businesses
   SET verified_handle = LOWER(REGEXP_REPLACE(name, '[^a-zA-Z0-9]+', '-', 'g'))
 WHERE status = 'verified' AND verified_handle IS NULL;

CREATE TABLE IF NOT EXISTS business_blocks (
  block_id     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  business_id  UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (user_id, business_id)
);

CREATE TABLE IF NOT EXISTS business_reports (
  report_id    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  business_id  UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  reason       TEXT,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_blocks_user ON business_blocks (user_id);
CREATE INDEX IF NOT EXISTS idx_business_reports_biz ON business_reports (business_id, created_at DESC);

-- Track last opened thread for unread hints
ALTER TABLE business_subscriptions
  ADD COLUMN IF NOT EXISTS last_read_at TIMESTAMPTZ;
