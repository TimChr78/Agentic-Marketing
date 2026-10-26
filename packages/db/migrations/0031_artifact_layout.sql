-- Step positions are how a person arranged the canvas, not what a journey does. Keeping them in
-- their own row means moving a step does not create a draft version (issue #117); the version's
-- own positions remain the fallback for anyone opening the journey elsewhere.
CREATE TABLE artifact_layout (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  layout jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL,
  PRIMARY KEY (workspace_id, artifact_id),
  FOREIGN KEY (workspace_id, artifact_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE artifact_layout ENABLE ROW LEVEL SECURITY;
ALTER TABLE artifact_layout FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON artifact_layout
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON artifact_layout TO am_app;
-- Discarding a draft deletes its unpublished versions (and their approval rows cascade).
GRANT DELETE ON artifact_versions, approval_requests TO am_app;
