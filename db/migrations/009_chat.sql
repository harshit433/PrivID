-- Chat / messaging support (Stream Chat integration)
--
-- Connection type is intentionally NOT duplicated here: messaging shares the
-- exact same `connections.connection_type` as calls, so a single relationship
-- governs both voice/video reachability and messaging.
--
-- These tables back the server-authoritative message-permission enforcement
-- (unknown senders capped at a small intro allowance, temporary senders capped
-- by a relaxed daily limit) and provide an auditable record of every message
-- that flows through the system. Rows are written by the Stream "before message
-- send" webhook.

-- ─── Channel registry ─────────────────────────────────────────────────────────
-- One row per 1:1 messaging channel. member_low/member_high are the two
-- participant user_ids sorted lexicographically so the pair is unique and the
-- Stream channel id is deterministic.

CREATE TABLE IF NOT EXISTS chat_channels (
  channel_cid   TEXT PRIMARY KEY,                 -- e.g. 'messaging:<uuidA>__<uuidB>'
  member_low    UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  member_high   UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE (member_low, member_high)
);

CREATE INDEX IF NOT EXISTS idx_chat_channels_low  ON chat_channels (member_low);
CREATE INDEX IF NOT EXISTS idx_chat_channels_high ON chat_channels (member_high);

-- ─── Message log ──────────────────────────────────────────────────────────────
-- Append-only audit of every accepted message. Used to count how many messages
-- a sender has sent to a recipient (intro cap + relaxed daily limit enforcement).

CREATE TABLE IF NOT EXISTS chat_message_log (
  message_id    TEXT PRIMARY KEY,                 -- Stream message id
  channel_cid   TEXT NOT NULL,
  sender_id     UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  recipient_id  UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  created_at    TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_chat_msg_sender_recipient
  ON chat_message_log (sender_id, recipient_id, created_at DESC);
CREATE INDEX IF NOT EXISTS idx_chat_msg_channel
  ON chat_message_log (channel_cid, created_at DESC);

DO $$ BEGIN
  CREATE TRIGGER trg_chat_channels_updated_at
    BEFORE UPDATE ON chat_channels
    FOR EACH ROW EXECUTE FUNCTION set_updated_at();
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
