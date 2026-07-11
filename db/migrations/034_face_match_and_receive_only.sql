-- 034: ephemeral face-match images, disposable receive-only, device fingerprint

ALTER TABLE onboarding_sessions
  ADD COLUMN IF NOT EXISTS doc_photo_b64 TEXT,
  ADD COLUMN IF NOT EXISTS selfie_b64 TEXT;

ALTER TABLE contact_shares
  ADD COLUMN IF NOT EXISTS receive_only BOOLEAN NOT NULL DEFAULT TRUE;

ALTER TABLE device_registrations
  ADD COLUMN IF NOT EXISTS device_fingerprint TEXT;

CREATE INDEX IF NOT EXISTS idx_devices_fingerprint
  ON device_registrations (device_fingerprint)
  WHERE device_fingerprint IS NOT NULL;
