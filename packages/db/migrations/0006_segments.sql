-- Segment memberships (data-platform.md §6). Kept current by streaming evaluation as events
-- arrive and by batch recomputation; entering and leaving are also emitted as events.
CREATE TABLE segment_memberships (
  workspace_id uuid NOT NULL,
  segment_id text NOT NULL,
  profile_id text NOT NULL,
  since timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, segment_id, profile_id),
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX segment_memberships_profile ON segment_memberships (workspace_id, profile_id);

CREATE TABLE segment_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  version integer NOT NULL,
  members integer NOT NULL,
  entered integer NOT NULL,
  exited integer NOT NULL,
  took_ms integer NOT NULL,
  at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, segment_id)
);

DO $$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['segment_memberships', 'segment_runs'] LOOP
    EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', t);
    EXECUTE format($p$CREATE POLICY tenant_isolation ON %I
      USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
      WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)$p$, t);
  END LOOP;
END $$;

GRANT SELECT, INSERT, UPDATE, DELETE ON segment_memberships, segment_runs TO am_app;
