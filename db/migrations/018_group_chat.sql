-- Group chat: metadata + membership tables
-- Groups are backed by Stream Chat messaging channels with is_group = true.
-- We mirror membership here so the backend can enforce admin-only operations
-- without an extra round-trip to Stream's management API.

CREATE TABLE group_channels (
  group_id    UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_cid TEXT        UNIQUE NOT NULL,  -- e.g. 'messaging:group-<uuid>'
  name        TEXT        NOT NULL CHECK (char_length(trim(name)) >= 1 AND char_length(trim(name)) <= 100),
  description TEXT,
  avatar_url  TEXT,
  created_by  UUID        NOT NULL REFERENCES users(user_id),
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE group_members (
  group_id  UUID        NOT NULL REFERENCES group_channels(group_id) ON DELETE CASCADE,
  user_id   UUID        NOT NULL REFERENCES users(user_id)           ON DELETE CASCADE,
  role      TEXT        NOT NULL DEFAULT 'member' CHECK (role IN ('admin', 'member')),
  joined_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (group_id, user_id)
);

CREATE INDEX idx_group_members_user_id  ON group_members(user_id);
CREATE INDEX idx_group_channels_creator ON group_channels(created_by);
