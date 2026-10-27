-- Holdout assignments (#67): one immutable arm per person per scope version. Journeys use this
-- now; campaigns reuse the same table with scope_type = 'campaign'. The arm is assigned at entry,
-- before any message, and survives re-entry, restarts and profile merges. Erasing a profile
-- cascades here, so aggregate holdout results drop with them.
CREATE TABLE holdout_assignments (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  scope_type text NOT NULL CHECK (scope_type IN ('journey', 'campaign')),
  scope_id text NOT NULL,
  hash_version text NOT NULL,
  profile_id text NOT NULL,
  arm text NOT NULL CHECK (arm IN ('control', 'treatment')),
  assigned_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, scope_type, scope_id, hash_version, profile_id),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX holdout_assignments_profile ON holdout_assignments (workspace_id, profile_id);
CREATE INDEX holdout_assignments_scope ON holdout_assignments (workspace_id, scope_type, scope_id, hash_version);

ALTER TABLE holdout_assignments ENABLE ROW LEVEL SECURITY;
ALTER TABLE holdout_assignments FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON holdout_assignments
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Assignments are append-only from the app role: a merge moves rows in a migration-like update,
-- which the owner role performs; the app only ever inserts and reads.
GRANT SELECT, INSERT ON holdout_assignments TO am_app;

-- Profile merges move the merged-away person's arms to the survivor. This is the only mutation
-- the app role can cause; it runs as the owner, only in the caller's workspace, and keeps the
-- survivor's arm when it has one (otherwise the earliest of the merged profiles).
CREATE FUNCTION merge_holdout_assignments(p_from text, p_into text) RETURNS void
LANGUAGE plpgsql SECURITY DEFINER SET search_path = public AS $$
DECLARE
  ws uuid := nullif(current_setting('app.workspace_id', true), '')::uuid;
BEGIN
  IF ws IS NULL THEN RAISE EXCEPTION 'no workspace'; END IF;
  IF p_from = p_into THEN RETURN; END IF;
  UPDATE holdout_assignments a
  SET assigned_at = LEAST(a.assigned_at, b.assigned_at)
  FROM holdout_assignments b
  WHERE a.workspace_id = ws AND a.profile_id = p_into
    AND b.workspace_id = ws AND b.profile_id = p_from
    AND a.scope_type = b.scope_type AND a.scope_id = b.scope_id AND a.hash_version = b.hash_version
    AND b.assigned_at < a.assigned_at;
  INSERT INTO holdout_assignments (workspace_id, scope_type, scope_id, hash_version, profile_id, arm, assigned_at)
  SELECT workspace_id, scope_type, scope_id, hash_version, p_into, arm, assigned_at
  FROM holdout_assignments WHERE workspace_id = ws AND profile_id = p_from
  ON CONFLICT (workspace_id, scope_type, scope_id, hash_version, profile_id) DO NOTHING;
  DELETE FROM holdout_assignments WHERE workspace_id = ws AND profile_id = p_from;
END $$;
REVOKE ALL ON FUNCTION merge_holdout_assignments(text, text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION merge_holdout_assignments(text, text) TO am_app;
