ALTER TABLE users
  ADD COLUMN IF NOT EXISTS discovery_mode VARCHAR(10) NOT NULL DEFAULT 'public'
    CHECK (discovery_mode IN ('public', 'private'));
