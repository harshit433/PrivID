-- Enforce at most one active session per direct pair and per group.
-- Uses partial unique indexes (only for status = 'active').

CREATE UNIQUE INDEX idx_one_active_direct_session
  ON activity_sessions (direct_member_low, direct_member_high)
  WHERE scope_type = 'direct' AND status = 'active';

CREATE UNIQUE INDEX idx_one_active_group_session
  ON activity_sessions (group_id)
  WHERE scope_type = 'group' AND status = 'active';
