-- One brand per token or OAuth connection (#187).
--
-- An OAuth consent is issued for one workspace: the person picks the brand on the consent page
-- when they belong to several, and the grant's reference id is that workspace. The consent page
-- writes the pending choice here first; the OAuth provider reads it in `consentReferenceId` and
-- stores it on the grant. The table is a short-lived hand-off keyed by the Better Auth session,
-- not a second membership model: nothing here grants access on its own.
CREATE TABLE oauth_workspace_selections (
  session_id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX oauth_workspace_selections_workspace ON oauth_workspace_selections (workspace_id);

ALTER TABLE oauth_workspace_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE oauth_workspace_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON oauth_workspace_selections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON oauth_workspace_selections TO am_app;

COMMENT ON TABLE oauth_workspace_selections IS
  'Pending OAuth consent workspace choice for one Better Auth session (#187); the grant itself stores it as its reference id.';
