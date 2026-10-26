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

-- Discarding a draft (artifacts.discardDraft) deletes the unpublished versions after the live one.
-- The app role gets no DELETE on versions or approval requests: this function is the only way, and
-- it only acts on the caller's workspace, only on draft or rejected versions after a live one,
-- never while a request is pending, and removes only those versions' decided requests.
CREATE FUNCTION discard_artifact_drafts(p_artifact text) RETURNS integer[]
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
  live integer;
  numbers integer[];
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'no workspace'; END IF;
  SELECT published_version INTO live FROM artifacts WHERE workspace_id = ws AND id = p_artifact FOR UPDATE;
  IF live IS NULL THEN RAISE EXCEPTION 'artifact % has no live version', p_artifact; END IF;
  IF EXISTS (SELECT 1 FROM approval_requests WHERE workspace_id = ws AND artifact_id = p_artifact AND version > live AND status = 'pending') THEN
    RAISE EXCEPTION 'a version of % is waiting for approval', p_artifact;
  END IF;
  IF EXISTS (SELECT 1 FROM artifact_versions WHERE workspace_id = ws AND artifact_id = p_artifact AND number > live AND state NOT IN ('draft', 'rejected')) THEN
    RAISE EXCEPTION 'a version of % after the live one is neither a draft nor rejected', p_artifact;
  END IF;
  SELECT coalesce(array_agg(number ORDER BY number), '{}') INTO numbers
    FROM artifact_versions WHERE workspace_id = ws AND artifact_id = p_artifact AND number > live;
  DELETE FROM approval_requests WHERE workspace_id = ws AND artifact_id = p_artifact AND version > live;
  DELETE FROM artifact_versions WHERE workspace_id = ws AND artifact_id = p_artifact AND number > live;
  UPDATE artifacts SET latest_version = live, updated_at = now() WHERE workspace_id = ws AND id = p_artifact;
  RETURN numbers;
END $$;
REVOKE ALL ON FUNCTION discard_artifact_drafts(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION discard_artifact_drafts(text) TO am_app;
