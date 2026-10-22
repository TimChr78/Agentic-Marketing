-- Wave 2, Phase 10: AI budgets hold under concurrency. Before a model call, its estimated tokens
-- are reserved (under a per-provider lock); the month's usage counts reservations too, so parallel
-- calls cannot together overshoot. A reservation ends with its call, or expires if the call died.
CREATE TABLE ai_token_reservations (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  provider_id text NOT NULL,
  tokens integer NOT NULL CHECK (tokens > 0),
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX ai_token_reservations_provider ON ai_token_reservations (workspace_id, provider_id, expires_at);

ALTER TABLE ai_token_reservations ENABLE ROW LEVEL SECURITY;
ALTER TABLE ai_token_reservations FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON ai_token_reservations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON ai_token_reservations TO am_app;
