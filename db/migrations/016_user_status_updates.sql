-- 016_user_status_updates.sql
-- WhatsApp-style ephemeral status (24h), text / image / video.

DO $$ BEGIN
  CREATE TYPE status_update_type AS ENUM ('text', 'image', 'video');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS user_status_updates (
  status_id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id            UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type               status_update_type NOT NULL,
  text_body          TEXT,
  media_url          TEXT,
  media_content_type TEXT,
  duration_ms        INTEGER,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  expires_at         TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '24 hours'),
  CONSTRAINT status_text_len CHECK (
    text_body IS NULL OR (LENGTH(TRIM(text_body)) >= 1 AND LENGTH(text_body) <= 700)
  ),
  CONSTRAINT status_video_duration CHECK (
    duration_ms IS NULL OR (duration_ms > 0 AND duration_ms <= 60000)
  ),
  CONSTRAINT status_media_by_type CHECK (
    (type = 'text' AND text_body IS NOT NULL AND media_url IS NULL)
    OR (type IN ('image', 'video') AND media_url IS NOT NULL)
  )
);

CREATE INDEX IF NOT EXISTS idx_status_user_expires
  ON user_status_updates (user_id, expires_at DESC);

CREATE INDEX IF NOT EXISTS idx_status_expires
  ON user_status_updates (expires_at);
