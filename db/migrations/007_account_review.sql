-- Account review: when trust score drops below 20 the account is placed
-- under review and callers are blocked until a moderator or automated check
-- clears it.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS is_under_review  BOOLEAN NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS review_reason    TEXT,
  ADD COLUMN IF NOT EXISTS review_started_at TIMESTAMPTZ;

CREATE INDEX IF NOT EXISTS idx_users_under_review ON users (is_under_review) WHERE is_under_review = TRUE;
