-- 015_admin_infrastructure.sql
--
-- Admin review resolution infrastructure:
--
--   admin_actions      — immutable audit log of every admin decision.
--                        Accountability: every action is recorded, never deleted.
--
--   users additions:
--     call_restriction_until — set by the 'restrict' action. Calls route
--                              checks this and applies a tighter daily cap for
--                              non-trusted outgoing calls while active.
--     is_monitored           — set by the 'monitor' action. ML auto-feedback
--                              job uses this to lower the block-count threshold
--                              for re-submitting training labels.
--     warning_count          — incremented on each 'warn' action, enabling
--                              graduated enforcement: warn → restrict → suspend.
--
-- All columns added with IF NOT EXISTS / ADD COLUMN IF NOT EXISTS so this
-- migration is safe to re-run on databases that already partially applied it.

-- ─── Admin actions audit table ────────────────────────────────────────────────

CREATE TABLE IF NOT EXISTS admin_actions (
  action_id  UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  target_id  UUID        REFERENCES users(user_id) ON DELETE SET NULL,
  action     TEXT        NOT NULL,   -- 'clear' | 'warn' | 'restrict' | 'suspend' | 'monitor'
                                     -- | 'ml_feedback' | 'trust_override' | 'bulk_clear'
  admin_ref  TEXT,                   -- optional identifier for which admin acted
                                     -- (e.g. hash of the API key, rotation epoch)
  note       TEXT,                   -- human-readable admin note
  metadata   JSONB       NOT NULL DEFAULT '{}',  -- action-specific data
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Fast lookups: history for a specific user, and audit log by action type
CREATE INDEX IF NOT EXISTS idx_admin_actions_target
  ON admin_actions (target_id, created_at DESC)
  WHERE target_id IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_admin_actions_type
  ON admin_actions (action, created_at DESC);

-- Useful for "how many suspensions were issued in the last 30 days?" dashboards
CREATE INDEX IF NOT EXISTS idx_admin_actions_recent
  ON admin_actions (created_at DESC);

-- ─── User-level enforcement columns ──────────────────────────────────────────

ALTER TABLE users
  ADD COLUMN IF NOT EXISTS call_restriction_until TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS is_monitored           BOOLEAN  NOT NULL DEFAULT FALSE,
  ADD COLUMN IF NOT EXISTS warning_count          INTEGER  NOT NULL DEFAULT 0;

-- Fast check in the call initiation hot-path:
-- "Is the caller currently restricted?"
CREATE INDEX IF NOT EXISTS idx_users_restriction
  ON users (user_id, call_restriction_until)
  WHERE call_restriction_until IS NOT NULL;

-- Fast check for monitored users (used by ML feedback worker)
CREATE INDEX IF NOT EXISTS idx_users_monitored
  ON users (user_id)
  WHERE is_monitored = TRUE AND is_active = TRUE;
