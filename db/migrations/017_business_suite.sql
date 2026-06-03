-- 017_business_suite.sql
-- TrustRoute Business Suite: companies, channels, subscriptions, messaging.

DO $$ BEGIN
  CREATE TYPE business_status AS ENUM ('pending', 'verified', 'suspended', 'rejected');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_plan AS ENUM ('starter', 'growth', 'enterprise');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_channel_type AS ENUM ('transactional', 'promotional', 'otp');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_subscription_status AS ENUM ('pending', 'active', 'paused', 'cancelled');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_message_status AS ENUM ('queued', 'sending', 'sent', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

DO $$ BEGIN
  CREATE TYPE business_delivery_status AS ENUM ('pending', 'delivered', 'failed');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;

CREATE TABLE IF NOT EXISTS businesses (
  business_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name              TEXT NOT NULL,
  gstin             TEXT,
  cin               TEXT,
  category          TEXT NOT NULL,
  contact_email     TEXT NOT NULL,
  website           TEXT,
  logo_url          TEXT,
  status            business_status NOT NULL DEFAULT 'pending',
  api_key_hash      TEXT,
  plan              business_plan NOT NULL DEFAULT 'starter',
  rejection_reason  TEXT,
  verified_at       TIMESTAMPTZ,
  suspended_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT businesses_gstin_format CHECK (
    gstin IS NULL OR gstin ~ '^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z]{1}[1-9A-Z]{1}Z[0-9A-Z]{1}$'
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_businesses_gstin
  ON businesses (gstin) WHERE gstin IS NOT NULL AND status != 'rejected';

CREATE TABLE IF NOT EXISTS business_channels (
  channel_id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id                 UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  name                        TEXT NOT NULL,
  channel_type                business_channel_type NOT NULL DEFAULT 'transactional',
  daily_limit_per_subscriber  INTEGER NOT NULL DEFAULT 10
    CHECK (daily_limit_per_subscriber >= 1 AND daily_limit_per_subscriber <= 100),
  active                      BOOLEAN NOT NULL DEFAULT TRUE,
  created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_channels_business
  ON business_channels (business_id);

CREATE TABLE IF NOT EXISTS business_subscriptions (
  subscription_id  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id          UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  business_id      UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  channel_id       UUID NOT NULL REFERENCES business_channels(channel_id) ON DELETE CASCADE,
  status           business_subscription_status NOT NULL DEFAULT 'pending',
  subscribed_at    TIMESTAMPTZ,
  cancelled_at     TIMESTAMPTZ,
  created_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at       TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_subscriptions_user_channel UNIQUE (user_id, channel_id)
);

CREATE INDEX IF NOT EXISTS idx_business_subscriptions_channel_status
  ON business_subscriptions (channel_id, status);

CREATE INDEX IF NOT EXISTS idx_business_subscriptions_user
  ON business_subscriptions (user_id, status);

CREATE TABLE IF NOT EXISTS business_messages (
  message_id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  channel_id         UUID NOT NULL REFERENCES business_channels(channel_id) ON DELETE CASCADE,
  business_id          UUID NOT NULL REFERENCES businesses(business_id) ON DELETE CASCADE,
  content            TEXT NOT NULL CHECK (LENGTH(TRIM(content)) >= 1 AND LENGTH(content) <= 4096),
  template_id        TEXT,
  total_subscribers  INTEGER NOT NULL DEFAULT 0,
  total_delivered    INTEGER NOT NULL DEFAULT 0,
  total_failed       INTEGER NOT NULL DEFAULT 0,
  status             business_message_status NOT NULL DEFAULT 'queued',
  scheduled_at       TIMESTAMPTZ,
  sent_at            TIMESTAMPTZ,
  created_at         TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_business_messages_channel_created
  ON business_messages (channel_id, created_at DESC);

CREATE TABLE IF NOT EXISTS business_message_deliveries (
  delivery_id       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  message_id        UUID NOT NULL REFERENCES business_messages(message_id) ON DELETE CASCADE,
  subscription_id   UUID NOT NULL REFERENCES business_subscriptions(subscription_id) ON DELETE CASCADE,
  user_id           UUID NOT NULL REFERENCES users(user_id) ON DELETE CASCADE,
  status            business_delivery_status NOT NULL DEFAULT 'pending',
  error_message     TEXT,
  delivered_at      TIMESTAMPTZ,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT business_deliveries_message_sub UNIQUE (message_id, subscription_id)
);

CREATE INDEX IF NOT EXISTS idx_business_deliveries_message
  ON business_message_deliveries (message_id, status);
