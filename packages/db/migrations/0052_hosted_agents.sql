-- Wave 4, Phase 19 (#258, #86): hosted agents — an agent the platform runs itself on a schedule.
--
-- A hosted agent is an agent like any other: it has a sponsor, a status, a mandate and a ledger.
-- The only difference is that the platform starts its runs instead of an external MCP client.
-- Each run is a fresh copilot session on the in-process MCP client, with its own token and
-- tool-call budgets, and is recorded here for the sponsor to read.
--
-- The schedule is a small, strict format (`hourly`, `daily:HH:MM` or `weekly:mon:07:00`) read in
-- the workspace's time zone. `next_run_at` is always an absolute time; a disabled row has none.
CREATE TABLE hosted_agents (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  agent_id text NOT NULL,
  instructions text NOT NULL,
  schedule text NOT NULL,
  -- The permissions the run may use, intersected with the sponsor's role.
  scopes text[] NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  max_tokens_per_run integer NOT NULL DEFAULT 20000 CHECK (max_tokens_per_run > 0),
  max_tool_calls_per_run integer NOT NULL DEFAULT 20 CHECK (max_tool_calls_per_run > 0),
  -- An optional AI provider id; null uses the workspace's copilot provider.
  model_provider_id text,
  -- Consecutive failed runs; three in a row disable the agent and tell its sponsor.
  consecutive_failures integer NOT NULL DEFAULT 0,
  last_run_at timestamptz,
  next_run_at timestamptz,
  -- One run per agent at a time, across scheduler processes. A stale claim is taken over below.
  running_run_id text,
  running_started_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, agent_id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX hosted_agents_due ON hosted_agents (next_run_at) WHERE enabled AND next_run_at IS NOT NULL;

CREATE TABLE hosted_agent_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  agent_id text NOT NULL,
  started_at timestamptz NOT NULL,
  finished_at timestamptz,
  status text NOT NULL CHECK (status IN ('ok', 'failed', 'skipped')),
  summary text NOT NULL DEFAULT '',
  tool_calls integer NOT NULL DEFAULT 0,
  tokens integer NOT NULL DEFAULT 0,
  error text,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES hosted_agents (workspace_id, agent_id) ON DELETE CASCADE
);

CREATE INDEX hosted_agent_runs_agent ON hosted_agent_runs (workspace_id, agent_id, started_at DESC);

-- A hosted agent is an agent principal too: the credential kind records how it acts.
ALTER TABLE agent_credentials DROP CONSTRAINT agent_credentials_kind_check;
ALTER TABLE agent_credentials ADD CONSTRAINT agent_credentials_kind_check CHECK (kind IN ('api_token', 'oauth_client', 'hosted'));

ALTER TABLE hosted_agents ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agents FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hosted_agents
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE hosted_agent_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hosted_agent_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON hosted_agents TO am_app;
GRANT SELECT, INSERT, UPDATE ON hosted_agent_runs TO am_app;
