-- Phase 5: Disposable handles + share tracking

CREATE TABLE IF NOT EXISTS contact_shares (
  share_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_id        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  token           TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL CHECK (type IN ('permanent', 'disposable')),
  label           TEXT,
  expires_at      TIMESTAMPTZ,
  max_uses        INT,
  uses            INT NOT NULL DEFAULT 0,
  active          BOOLEAN NOT NULL DEFAULT TRUE,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  revoked_at      TIMESTAMPTZ
);

CREATE TABLE IF NOT EXISTS share_events (
  event_id        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  share_id        UUID NOT NULL REFERENCES contact_shares(share_id) ON DELETE CASCADE,
  scanner_id      UUID REFERENCES users(user_id) ON DELETE SET NULL,
  device_hash     TEXT,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_contact_shares_owner_active
  ON contact_shares (owner_id, active, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_contact_shares_token_active
  ON contact_shares (token) WHERE active = TRUE;
CREATE INDEX IF NOT EXISTS idx_share_events_share
  ON share_events (share_id, created_at DESC);
