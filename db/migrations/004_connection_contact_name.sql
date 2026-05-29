-- Per-owner display name for a saved contact (phone-book style).
ALTER TABLE connections
  ADD COLUMN IF NOT EXISTS contact_name TEXT;
