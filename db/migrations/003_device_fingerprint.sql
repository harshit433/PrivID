-- Add device fingerprint for SIM-binding / device continuity checks
-- fingerprint = sha256(ANDROID_ID + phone_hash), stored on first verification
-- and compared on every subsequent device verify call.

ALTER TABLE device_registrations
  ADD COLUMN IF NOT EXISTS device_fingerprint TEXT,
  ADD COLUMN IF NOT EXISTS hardware_id TEXT;

-- Allow fast lookup: has this hardware_id ever been tied to another user?
CREATE INDEX IF NOT EXISTS idx_device_reg_hardware_id
  ON device_registrations (hardware_id)
  WHERE hardware_id IS NOT NULL;
