-- Phase 11 (wave 2), part d: push notifications. Providers like SMS providers (settings readable,
-- credentials sealed); device registrations sealed with the workspace key and tied to the
-- anonymous and user ids they were registered with, so they follow identity resolution.

CREATE TABLE push_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('webpush', 'fcm', 'apns', 'log')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets bytea,
  secrets_key_id text,
  use_for text[] NOT NULL DEFAULT '{}' CHECK (use_for <@ ARRAY['transactional', 'marketing']),
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, secrets_key_id) REFERENCES data_keys (workspace_id, id)
);

CREATE TABLE push_subscriptions (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('web', 'fcm', 'apns')),
  anonymous_id text,
  user_id text,
  -- sha256 of the endpoint or device token: one row per device, whoever registers it last.
  token_hash text NOT NULL,
  secrets bytea NOT NULL,
  secrets_key_id text NOT NULL,
  source_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  last_sent_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, token_hash),
  CHECK (anonymous_id IS NOT NULL OR user_id IS NOT NULL),
  FOREIGN KEY (workspace_id, secrets_key_id) REFERENCES data_keys (workspace_id, id)
);
CREATE INDEX push_subscriptions_anonymous ON push_subscriptions (workspace_id, anonymous_id) WHERE anonymous_id IS NOT NULL;
CREATE INDEX push_subscriptions_user ON push_subscriptions (workspace_id, user_id) WHERE user_id IS NOT NULL;

ALTER TABLE push_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_providers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE push_subscriptions ENABLE ROW LEVEL SECURITY;
ALTER TABLE push_subscriptions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON push_subscriptions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON push_providers, push_subscriptions TO am_app;
