-- 014_user_presence.sql
--
-- User status text, emoji, and last-seen timestamp.
--
-- last_seen_at is written by the API middleware on every authenticated request,
-- throttled via Redis to at most one PostgreSQL write per 2 minutes per user.
--
-- Presence tiers (computed at query time, not stored):
--   online  — last_seen_at within the last  3 minutes
--   away    — last_seen_at within the last 30 minutes
--   offline — last_seen_at older than 30 minutes, or NULL

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS status_text  TEXT          CHECK (LENGTH(status_text) <= 140),
  ADD COLUMN IF NOT EXISTS status_emoji TEXT          CHECK (LENGTH(status_emoji) <= 8),
  ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ;

-- Supports listing "recently active" contacts efficiently
CREATE INDEX IF NOT EXISTS idx_users_last_seen
  ON users (last_seen_at DESC)
  WHERE last_seen_at IS NOT NULL;

-- Add presence key prefix to the Redis keys table (informational — no SQL needed)
-- Key shape: presence:{user_id}  TTL: 120 s  Value: '1'
-- Set with NX so a write to PostgreSQL happens at most once per 2 minutes.
