-- Static and snapshot audiences (issue #83). segment_list_members is the source of truth for a
-- static/snapshot segment's list; the same rows are mirrored into segment_memberships so
-- broadcasts, journeys and every existing reader keep working unchanged. Deleting a profile
-- (erasure) cascades here, and segment deletion cascades too.

CREATE TABLE segment_list_members (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  segment_id text NOT NULL,
  profile_id text NOT NULL,
  added_at timestamptz NOT NULL DEFAULT now(),
  added_by text,
  source text NOT NULL DEFAULT 'manual' CHECK (source IN ('manual', 'api', 'csv', 'snapshot')),
  PRIMARY KEY (workspace_id, segment_id, profile_id),
  FOREIGN KEY (workspace_id, segment_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE,
  FOREIGN KEY (workspace_id, profile_id) REFERENCES profiles (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX segment_list_members_added ON segment_list_members (workspace_id, segment_id, added_at DESC, profile_id);

CREATE TABLE segment_list_imports (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  segment_id text NOT NULL,
  file_name text,
  file_sha256 text,
  rows integer NOT NULL CHECK (rows >= 0),
  matched integer NOT NULL CHECK (matched >= 0),
  added integer NOT NULL CHECK (added >= 0),
  -- Row numbers and reasons only: never the matched or rejected values (personal data).
  unmatched jsonb NOT NULL DEFAULT '[]'::jsonb,
  actor text,
  source text NOT NULL DEFAULT 'csv' CHECK (source IN ('csv', 'snapshot')),
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, segment_id) REFERENCES artifacts (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX segment_list_imports_recent ON segment_list_imports (workspace_id, segment_id, created_at DESC, id DESC);

ALTER TABLE segment_list_members ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_list_members FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON segment_list_members
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

ALTER TABLE segment_list_imports ENABLE ROW LEVEL SECURITY;
ALTER TABLE segment_list_imports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON segment_list_imports
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- DELETE is only on the member list (editing a list removes rows); import history is append-only.
GRANT SELECT, INSERT, DELETE ON segment_list_members TO am_app;
GRANT SELECT, INSERT ON segment_list_imports TO am_app;
