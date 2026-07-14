-- Matrix chat: user/room mapping + feature flag.
-- Replaces native Postgres WS chat as the messaging transport when matrix_chat_enabled is true.

CREATE TABLE IF NOT EXISTS matrix_users (
  user_id     UUID PRIMARY KEY REFERENCES users(user_id) ON DELETE CASCADE,
  mxid        TEXT NOT NULL UNIQUE,
  localpart   TEXT NOT NULL UNIQUE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS matrix_rooms (
  room_id          TEXT PRIMARY KEY,
  type             TEXT NOT NULL CHECK (type IN ('dm', 'group')),
  -- For DMs: ordered pair of PrivID user ids (low:high).
  dm_key           TEXT UNIQUE,
  group_id         UUID UNIQUE REFERENCES group_channels(group_id) ON DELETE SET NULL,
  created_by       UUID REFERENCES users(user_id) ON DELETE SET NULL,
  title            TEXT,
  avatar_url       TEXT,
  encryption       BOOLEAN NOT NULL DEFAULT FALSE,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_matrix_rooms_dm_key ON matrix_rooms (dm_key) WHERE dm_key IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_matrix_rooms_group ON matrix_rooms (group_id) WHERE group_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS matrix_room_members (
  room_id    TEXT NOT NULL REFERENCES matrix_rooms(room_id) ON DELETE CASCADE,
  user_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role       TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (room_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_matrix_room_members_user ON matrix_room_members (user_id);

INSERT INTO feature_flags (key, value, updated_at)
VALUES ('matrix_chat_enabled', 'true'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();

-- Prefer Matrix over native when migrating; native stays as offline fallback code-path only.
INSERT INTO feature_flags (key, value, updated_at)
VALUES ('native_chat_enabled', 'false'::jsonb, NOW())
ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = NOW();
