-- AI runtime (Phase 4): LLM providers with the workspace's own keys (sealed like e-mail provider
-- credentials), and the AI call log. The log is also the work queue of AI journey steps: the AI
-- worker claims pending rows, calls the model outside any transaction and records the outcome.
CREATE TABLE ai_providers (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('openai-compatible', 'anthropic-compatible')),
  base_url text NOT NULL,
  models jsonb NOT NULL,
  structured_outputs boolean NOT NULL DEFAULT true,
  use_for text[] NOT NULL DEFAULT '{}',
  monthly_token_budget bigint,
  region text NOT NULL DEFAULT '',
  secrets bytea,
  secrets_key_id text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE TABLE ai_calls (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('decide', 'generate', 'copilot', 'test')),
  status text NOT NULL CHECK (status IN ('pending', 'running', 'done', 'fallback', 'failed')),
  -- Pending steps wait for the worker; a running one whose lease ran out is claimed again.
  lease_until timestamptz,
  attempts integer NOT NULL DEFAULT 0,
  idempotency_key text,
  provider_id text,
  model text,
  prompt_id text,
  prompt_version integer,
  journey_id text,
  participant_id bigint,
  node text,
  seq integer,
  profile_id text,
  -- The (minimised, pseudonymised) context the model saw, and what it answered.
  input jsonb NOT NULL DEFAULT '{}',
  output jsonb,
  rationale text,
  error text,
  input_tokens integer NOT NULL DEFAULT 0,
  output_tokens integer NOT NULL DEFAULT 0,
  latency_ms integer,
  principal_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  finished_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, idempotency_key),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX ai_calls_queue ON ai_calls (created_at) WHERE status IN ('pending', 'running');
CREATE INDEX ai_calls_recent ON ai_calls (workspace_id, created_at DESC);
CREATE INDEX ai_calls_usage ON ai_calls (workspace_id, provider_id, created_at);

ALTER TABLE ai_providers ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_providers FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_providers
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE ai_calls ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_calls FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_calls
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON ai_providers TO am_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_calls TO am_app;
