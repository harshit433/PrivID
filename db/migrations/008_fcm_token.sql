-- Store FCM push token directly on the user row.
-- Simpler and more reliable than querying device_registrations.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS fcm_token TEXT;

CREATE INDEX IF NOT EXISTS idx_users_fcm_token ON users (user_id)
  WHERE fcm_token IS NOT NULL;
