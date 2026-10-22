-- E-mail providers and the message log of the send gateway (ADR-0007, ADR-0011).

-- A configured delivery provider. Credentials are sealed with the workspace's secrets data key;
-- the webhook token authenticates the provider's delivery events (only its hash is stored).
CREATE TABLE email_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('smtp', 'ses', 'postmark', 'brevo', 'log')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets bytea,
  secrets_key_id text,
  from_email text NOT NULL,
  from_name text NOT NULL DEFAULT '',
  reply_to text,
  use_for text[] NOT NULL DEFAULT '{}' CHECK (use_for <@ ARRAY['transactional', 'marketing']),
  webhook_token_hash text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, secrets_key_id) REFERENCES data_keys (workspace_id, id)
);

-- Every send request and what became of it, including the ones the gateway refused.
-- The idempotency key makes a repeated request (a retried journey step) return the first result.
CREATE TABLE messages (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  idempotency_key text NOT NULL,
  channel text NOT NULL DEFAULT 'email',
  profile_id text,
  purpose text NOT NULL,
  template_id text,
  template_version integer,
  journey_id text,
  provider_id text,
  provider_message_id text,
  status text NOT NULL CHECK (status IN ('queued', 'sending', 'sent', 'suppressed', 'failed', 'delivered', 'bounced', 'complained')),
  reason text,
  recipient_hash text,
  -- Variables from the request (e.g. the triggering event), used when rendering.
  data jsonb NOT NULL DEFAULT '{}',
  attempts integer NOT NULL DEFAULT 0,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key)
);
CREATE INDEX messages_profile ON messages (workspace_id, profile_id, created_at DESC);
CREATE INDEX messages_queued ON messages (created_at) WHERE status IN ('queued', 'sending');
CREATE INDEX messages_provider_message ON messages (provider_message_id) WHERE provider_message_id IS NOT NULL;

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['email_providers', 'messages'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON email_providers TO am_app;
GRANT SELECT, INSERT, UPDATE ON messages TO am_app;
-- Erasure removes the person from the message log too.
GRANT DELETE ON messages TO am_app;
