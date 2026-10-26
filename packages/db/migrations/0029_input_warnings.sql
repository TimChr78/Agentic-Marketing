-- Evidence for turning STRICT_INPUTS on (#124): every key a client sent that the command schema
-- ignored, with first/last seen and a count. Key paths only: values are never stored, because they
-- may contain personal data or secrets. The client is an API token, a person or an OAuth client.
CREATE TABLE input_warnings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  principal_type text NOT NULL CHECK (principal_type IN ('user', 'token', 'oauth_client')),
  principal_id text NOT NULL,
  client_label text NOT NULL,
  command text NOT NULL,
  key_path text NOT NULL,
  first_seen timestamptz NOT NULL DEFAULT now(),
  last_seen timestamptz NOT NULL DEFAULT now(),
  count integer NOT NULL DEFAULT 1,
  PRIMARY KEY (workspace_id, principal_type, principal_id, command, key_path)
);
CREATE INDEX input_warnings_last_seen ON input_warnings (workspace_id, last_seen);

ALTER TABLE input_warnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE input_warnings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON input_warnings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON input_warnings TO am_app;
