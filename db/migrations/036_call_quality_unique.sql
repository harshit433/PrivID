-- One call-quality report per participant per call.
--
-- POST /calls/:id/quality upserts with ON CONFLICT (call_id, user_id) but the
-- table only had a PK on report_id, so every submission threw 42P10
-- ("no unique or exclusion constraint matching the ON CONFLICT specification")
-- and returned 500. Add the missing unique constraint (deduping first).

DELETE FROM call_quality_reports a
USING call_quality_reports b
WHERE a.ctid < b.ctid
  AND a.call_id = b.call_id
  AND a.user_id = b.user_id;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM pg_constraint WHERE conname = 'call_quality_reports_call_user_uniq'
  ) THEN
    ALTER TABLE call_quality_reports
      ADD CONSTRAINT call_quality_reports_call_user_uniq UNIQUE (call_id, user_id);
  END IF;
END $$;
