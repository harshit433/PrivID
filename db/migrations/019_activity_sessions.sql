-- Activity sessions: shared experiences over trusted chat scopes.
--
-- Durable metadata lives in PostgreSQL. Live, low-latency state is mirrored to
-- Firebase RTDB under /activities/{activity_id}; LiveKit handles party voice
-- and screen-share media with a separate room per activity.

CREATE TABLE activity_sessions (
  activity_id        UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  scope_type         TEXT        NOT NULL CHECK (scope_type IN ('direct', 'group')),
  direct_member_low  UUID        REFERENCES users(user_id) ON DELETE CASCADE,
  direct_member_high UUID        REFERENCES users(user_id) ON DELETE CASCADE,
  group_id           UUID        REFERENCES group_channels(group_id) ON DELETE CASCADE,
  adapter            TEXT        NOT NULL CHECK (adapter IN ('youtube', 'screen_share')),
  status             TEXT        NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'ended')),
  livekit_room_id    TEXT        NOT NULL UNIQUE,
  host_user_id       UUID        NOT NULL REFERENCES users(user_id),
  controller_user_id UUID        NOT NULL REFERENCES users(user_id),
  presenter_user_id  UUID        REFERENCES users(user_id),
  created_by         UUID        NOT NULL REFERENCES users(user_id),
  last_state         JSONB       NOT NULL DEFAULT '{}'::jsonb,
  state_revision     INTEGER     NOT NULL DEFAULT 0,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  ended_at           TIMESTAMPTZ,

  CHECK (
    (scope_type = 'direct'
      AND direct_member_low IS NOT NULL
      AND direct_member_high IS NOT NULL
      AND direct_member_low <> direct_member_high
      AND group_id IS NULL)
    OR
    (scope_type = 'group'
      AND group_id IS NOT NULL
      AND direct_member_low IS NULL
      AND direct_member_high IS NULL)
  )
);

CREATE TABLE activity_participants (
  activity_id UUID        NOT NULL REFERENCES activity_sessions(activity_id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'participant' CHECK (role IN ('host', 'participant')),
  joined_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  left_at     TIMESTAMPTZ,
  PRIMARY KEY (activity_id, user_id)
);

CREATE INDEX idx_activity_sessions_direct
  ON activity_sessions (direct_member_low, direct_member_high, status, created_at DESC)
  WHERE scope_type = 'direct';

CREATE INDEX idx_activity_sessions_group
  ON activity_sessions (group_id, status, created_at DESC)
  WHERE scope_type = 'group';

CREATE INDEX idx_activity_participants_user
  ON activity_participants (user_id, left_at);

DO $$ BEGIN
  CREATE TRIGGER trg_activity_sessions_updated_at
    BEFORE UPDATE ON activity_sessions
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
