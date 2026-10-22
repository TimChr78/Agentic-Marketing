-- Integrations (Phase 5): API tokens for scripts and automation tools, outbound webhook
-- endpoints, connections to connectors (inbound webhooks and journey actions), and one delivery
-- queue for webhooks and actions with retries and a dead letter.

CREATE TABLE api_tokens (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  user_id text NOT NULL,
  name text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  token_hint text NOT NULL,
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz,
  last_used_at timestamptz,
  revoked_at timestamptz,
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE webhook_endpoints (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  url text NOT NULL,
  events text[] NOT NULL DEFAULT '{}',
  purpose text,
  secrets bytea NOT NULL,
  secrets_key_id text NOT NULL,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE connections (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  connector text NOT NULL,
  name text NOT NULL,
  settings jsonb NOT NULL DEFAULT '{}',
  secrets bytea,
  secrets_key_id text,
  -- Inbound connections receive at /hooks/in/<id>/<token>; only a hash of the token is kept.
  token_hash text UNIQUE,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE deliveries (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('webhook', 'action')),
  target_id text NOT NULL,
  action text,
  payload jsonb NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'failed', 'dead')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  idempotency_key text NOT NULL,
  status_code integer,
  response jsonb,
  error text,
  duration_ms integer,
  participant_id bigint,
  node text,
  seq integer,
  profile_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX deliveries_due ON deliveries (next_attempt_at) WHERE status IN ('pending', 'running');
CREATE INDEX deliveries_recent ON deliveries (workspace_id, target_id, created_at DESC);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['api_tokens', 'webhook_endpoints', 'connections', 'deliveries'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
    EXECUTE format('GRANT SELECT, INSERT, UPDATE, DELETE ON %I TO am_app', t);
  END LOOP;
END $$;
