-- Editable API tokens (#44). Every change to a token's name, scopes or expiry is recorded here,
-- along with creation and revocation, so the token detail can show its history. The token itself
-- keeps its value: only its hash is stored, and editing never rotates it.
CREATE TABLE api_token_changes (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  token_id text NOT NULL,
  changed_by text NOT NULL,
  changed_at timestamptz NOT NULL DEFAULT now(),
  changes jsonb NOT NULL,
  stepped_up boolean NOT NULL DEFAULT false,
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX api_token_changes_token ON api_token_changes (workspace_id, token_id, changed_at DESC);

ALTER TABLE api_token_changes ENABLE ROW LEVEL SECURITY;
ALTER TABLE api_token_changes FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON api_token_changes
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON api_token_changes TO am_app;
