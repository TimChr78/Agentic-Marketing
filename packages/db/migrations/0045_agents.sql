-- Wave 4, Phase 17 (#213, #215, #218; ADR-0016): agents as first-class principals.
--
-- An agent is a named principal with a sponsor (the member accountable for it), a status and
-- the credentials it acts with (API tokens, OAuth clients). Pausing an agent stops every one of
-- its credentials. Credentials are attached on first use, so existing tokens and OAuth clients
-- become agents without a data migration. `brand` is reserved for multi-brand (#184).
CREATE TABLE agents (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  description text NOT NULL DEFAULT '',
  sponsor_user_id text NOT NULL,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'paused', 'revoked')),
  status_reason text,
  status_changed_by text,
  status_changed_at timestamptz,
  brand text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE agent_credentials (
  workspace_id uuid NOT NULL,
  kind text NOT NULL CHECK (kind IN ('api_token', 'oauth_client')),
  credential_id text NOT NULL,
  agent_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, kind, credential_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX agent_credentials_agent ON agent_credentials (workspace_id, agent_id);

-- Every agent write with the policy decision that allowed, escalated or refused it (#218).
-- Counters for the per-agent limits are read from here.
CREATE TABLE agent_actions (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id bigserial NOT NULL,
  agent_id text NOT NULL,
  command text NOT NULL,
  action_class text NOT NULL,
  decision text NOT NULL CHECK (decision IN ('allow', 'ask', 'deny')),
  reasons jsonb NOT NULL DEFAULT '[]'::jsonb,
  impact jsonb NOT NULL DEFAULT '{}'::jsonb,
  ok boolean NOT NULL,
  error text,
  target text,
  surface text NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX agent_actions_agent ON agent_actions (workspace_id, agent_id, at DESC);

-- Workspace autonomy ceilings and the autonomy switch (#215). Empty means the defaults.
ALTER TABLE workspaces ADD COLUMN autonomy jsonb NOT NULL DEFAULT '{}'::jsonb;

ALTER TABLE agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE agent_credentials ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_credentials FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_credentials
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE agent_actions ENABLE ROW LEVEL SECURITY;
ALTER TABLE agent_actions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON agent_actions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON agents TO am_app;
GRANT SELECT, INSERT, DELETE ON agent_credentials TO am_app;
-- The ledger is append-only for the app.
GRANT SELECT, INSERT ON agent_actions TO am_app;
GRANT USAGE ON SEQUENCE agent_actions_id_seq TO am_app;
