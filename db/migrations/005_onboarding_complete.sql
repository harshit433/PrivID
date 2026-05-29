-- Add onboarding_complete flag to users table.
-- Existing users who have trust_score >= 50 (completed device + liveness) are
-- considered already onboarded.  Everyone else needs to finish the setup flow.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS onboarding_complete BOOLEAN NOT NULL DEFAULT FALSE;

-- Back-fill: mark already-verified users as complete so they aren't forced
-- through the setup flow again after a fresh install.
UPDATE users
  SET onboarding_complete = TRUE
  WHERE trust_score >= 50
    AND is_active = TRUE;
