-- 011_trust_factors_dedup.sql
--
-- Defensive cleanup for trust_factors.is_latest:
--
-- Migration 002 added the is_latest column (DEFAULT TRUE) and the partial
-- unique index. On a database that already had duplicate (user_id, factor_type)
-- rows before 002 ran, the CREATE UNIQUE INDEX … IF NOT EXISTS would have been
-- silently skipped, leaving the index absent and the ON CONFLICT clause in
-- auth.ts broken.
--
-- This migration:
--   1. Marks stale duplicate rows is_latest = FALSE (keeps most recent)
--   2. Re-ensures the partial unique index (idempotent)
--   3. Tightens the column constraint
--
-- Safe to run multiple times.

-- ── Step 1: De-duplicate ──────────────────────────────────────────────────────
-- For every (user_id, factor_type) group that has more than one
-- is_latest = TRUE row, keep only the single best row:
--   • prefer status = 'completed' over others
--   • then prefer the most recently created row
--
-- CTE returns the factor_ids that should be downgraded.

WITH ranked AS (
  SELECT
    factor_id,
    ROW_NUMBER() OVER (
      PARTITION BY user_id, factor_type
      ORDER BY
        CASE status WHEN 'completed' THEN 0 WHEN 'pending' THEN 1 ELSE 2 END,
        created_at DESC
    ) AS rn
  FROM trust_factors
  WHERE is_latest = TRUE
)
UPDATE trust_factors
SET    is_latest = FALSE
WHERE  factor_id IN (SELECT factor_id FROM ranked WHERE rn > 1);

-- ── Step 2: Ensure column constraints ────────────────────────────────────────
-- Idempotent — already done by 002 on clean databases, but harmless to repeat.

ALTER TABLE trust_factors
  ALTER COLUMN is_latest SET DEFAULT TRUE,
  ALTER COLUMN is_latest SET NOT NULL;

-- ── Step 3: Ensure partial unique index ──────────────────────────────────────
-- After step 1 there are guaranteed no duplicate (user_id, factor_type) pairs
-- with is_latest = TRUE, so this will succeed even on dirty databases.

CREATE UNIQUE INDEX IF NOT EXISTS idx_trust_factors_user_type_latest
  ON trust_factors (user_id, factor_type)
  WHERE is_latest = TRUE;

-- ── Step 4: Supporting indexes for getCompletedFactors hot path ──────────────

CREATE INDEX IF NOT EXISTS idx_trust_factors_completed
  ON trust_factors (user_id, factor_type, status)
  WHERE status = 'completed' AND is_latest = TRUE;
