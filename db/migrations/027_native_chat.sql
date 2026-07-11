-- Phase 4: Native chat (Postgres + WS) — extends Stream bridge tables

DO $$ BEGIN
  CREATE TYPE conv_type AS ENUM ('dm', 'group');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE chat_message_type AS ENUM ('text', 'image', 'video', 'audio', 'doc', 'contact', 'location', 'system');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

DO $$ BEGIN
  CREATE TYPE receipt_state AS ENUM ('delivered', 'read');
EXCEPTION WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS conversations (
  conv_id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  type              conv_type NOT NULL,
  created_by        UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  title             TEXT,
  avatar_ref        TEXT,
  description       TEXT,
  stream_channel_cid TEXT UNIQUE,
  group_id          UUID UNIQUE REFERENCES group_channels(group_id) ON DELETE SET NULL,
  last_seq          BIGINT NOT NULL DEFAULT 0,
  last_message_preview TEXT,
  last_message_at   TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE TABLE IF NOT EXISTS conversation_members (
  conv_id         UUID NOT NULL REFERENCES conversations(conv_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  role            TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  joined_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  muted_until     TIMESTAMPTZ,
  last_read_seq   BIGINT NOT NULL DEFAULT 0,
  pinned          BOOLEAN NOT NULL DEFAULT FALSE,
  archived        BOOLEAN NOT NULL DEFAULT FALSE,
  PRIMARY KEY (conv_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_conv_members_user ON conversation_members (user_id);

CREATE TABLE IF NOT EXISTS messages (
  msg_id      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  conv_id     UUID NOT NULL REFERENCES conversations(conv_id) ON DELETE CASCADE,
  seq         BIGINT NOT NULL,
  sender_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  type        chat_message_type NOT NULL DEFAULT 'text',
  body        TEXT,
  media_ref   TEXT,
  reply_to    UUID REFERENCES messages(msg_id) ON DELETE SET NULL,
  edited_at   TIMESTAMPTZ,
  deleted     BOOLEAN NOT NULL DEFAULT FALSE,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (conv_id, seq)
);

CREATE INDEX IF NOT EXISTS idx_messages_conv_seq ON messages (conv_id, seq DESC);

CREATE TABLE IF NOT EXISTS message_receipts (
  msg_id    UUID NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  state     receipt_state NOT NULL,
  at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (msg_id, user_id, state)
);

CREATE TABLE IF NOT EXISTS message_reactions (
  msg_id    UUID NOT NULL REFERENCES messages(msg_id) ON DELETE CASCADE,
  user_id   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  emoji     TEXT NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  PRIMARY KEY (msg_id, user_id)
);

CREATE TABLE IF NOT EXISTS media_assets (
  media_ref   TEXT PRIMARY KEY,
  owner_id    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  conv_id     UUID REFERENCES conversations(conv_id) ON DELETE SET NULL,
  kind        TEXT NOT NULL,
  size_bytes  BIGINT,
  thumb_ref   TEXT,
  s3_key      TEXT NOT NULL,
  status      TEXT NOT NULL DEFAULT 'ready',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

-- Backfill DM conversations from chat_channels
INSERT INTO conversations (conv_id, type, created_by, stream_channel_cid, created_at)
SELECT gen_random_uuid(), 'dm', member_low, channel_cid, created_at
FROM chat_channels cc
WHERE NOT EXISTS (
  SELECT 1 FROM conversations c WHERE c.stream_channel_cid = cc.channel_cid
);

INSERT INTO conversation_members (conv_id, user_id, role)
SELECT c.conv_id, cc.member_low, 'member'
FROM conversations c
JOIN chat_channels cc ON cc.channel_cid = c.stream_channel_cid
ON CONFLICT DO NOTHING;

INSERT INTO conversation_members (conv_id, user_id, role)
SELECT c.conv_id, cc.member_high, 'member'
FROM conversations c
JOIN chat_channels cc ON cc.channel_cid = c.stream_channel_cid
ON CONFLICT DO NOTHING;

-- Backfill group conversations
INSERT INTO conversations (conv_id, type, created_by, title, avatar_ref, description, stream_channel_cid, group_id, created_at)
SELECT gc.group_id, 'group', gc.created_by, gc.name, gc.avatar_url, gc.description, gc.channel_cid, gc.group_id, gc.created_at
FROM group_channels gc
WHERE NOT EXISTS (SELECT 1 FROM conversations c WHERE c.group_id = gc.group_id);

INSERT INTO conversation_members (conv_id, user_id, role)
SELECT gc.group_id, gm.user_id, gm.role
FROM group_channels gc
JOIN group_members gm ON gm.group_id = gc.group_id
JOIN conversations c ON c.group_id = gc.group_id
ON CONFLICT DO NOTHING;

INSERT INTO feature_flags (key, value) VALUES ('native_chat_enabled', 'true')
ON CONFLICT (key) DO NOTHING;
