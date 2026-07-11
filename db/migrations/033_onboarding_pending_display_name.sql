-- Store display name chosen at handle step until onboarding/complete.
ALTER TABLE onboarding_sessions
  ADD COLUMN IF NOT EXISTS pending_display_name TEXT;
