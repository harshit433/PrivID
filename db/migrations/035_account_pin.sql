-- Account login PIN (bcrypt hash). Used for @handle + PIN sign-in after DigiLocker KYC.
-- DigiLocker is only required again to reset a forgotten PIN.

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS pin_hash TEXT,
  ADD COLUMN IF NOT EXISTS pin_set_at TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS pin_failed_attempts INT NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS pin_locked_until TIMESTAMPTZ;

COMMENT ON COLUMN users.pin_hash IS 'bcrypt hash of 6-digit account PIN; never returned to clients';

-- Allow DigiLocker sessions specifically for forgotten-PIN reset
ALTER TABLE onboarding_sessions
  DROP CONSTRAINT IF EXISTS onboarding_sessions_purpose_check;

ALTER TABLE onboarding_sessions
  ADD CONSTRAINT onboarding_sessions_purpose_check
  CHECK (purpose IN ('signup', 'recovery', 'pin_reset'));
