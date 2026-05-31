-- Profile enrichment: optional contact + professional details shown on the
-- in-app profile screen. All fields are optional and user-editable.
ALTER TABLE users
  ADD COLUMN IF NOT EXISTS email         TEXT,
  ADD COLUMN IF NOT EXISTS profession    TEXT,
  ADD COLUMN IF NOT EXISTS bio           TEXT,
  ADD COLUMN IF NOT EXISTS business_info TEXT;
