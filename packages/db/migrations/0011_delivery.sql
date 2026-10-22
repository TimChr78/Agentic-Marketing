-- Wave 2, Phase 7: delivery beyond SMTP, and SMS.

-- Cloudflare Email Service as an e-mail provider.
ALTER TABLE email_providers DROP CONSTRAINT email_providers_adapter_check;
ALTER TABLE email_providers ADD CONSTRAINT email_providers_adapter_check
  CHECK (adapter IN ('smtp', 'ses', 'postmark', 'brevo', 'cloudflare', 'log'));

-- Messages held back (quiet hours, a paused stream) wait until not_before. An SMS records how
-- many segments it used, for cost and the monthly budget.
ALTER TABLE messages ADD COLUMN not_before timestamptz;
ALTER TABLE messages ADD COLUMN segments integer;
CREATE INDEX messages_recent ON messages (workspace_id, channel, created_at DESC);

-- SMS providers, like e-mail providers: sealed credentials, a webhook token for status callbacks
-- and inbound messages (STOP, HELP), one provider per use.
CREATE TABLE sms_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  adapter text NOT NULL CHECK (adapter IN ('twilio', 'log')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets bytea,
  secrets_key_id text,
  sender text NOT NULL,
  use_for text[] NOT NULL DEFAULT '{}' CHECK (use_for <@ ARRAY['transactional', 'marketing']),
  webhook_token_hash text NOT NULL UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, secrets_key_id) REFERENCES data_keys (workspace_id, id)
);

ALTER TABLE sms_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE sms_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sms_providers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON sms_providers TO am_app;
