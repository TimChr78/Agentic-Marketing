-- Identity tombstones for erasure (#210): keyed hashes of the identifiers of an erased person.
--
-- A queued or late event that names one of them is dropped by the resolver for a grace window
-- after the erasure (ERASURE_GRACE_HOURS, 24 by default) instead of creating a new profile.
-- Only HMAC hashes made with the workspace's matching key are stored, never the raw identifiers.
-- The hourly retention job removes rows older than the grace window plus seven days.
CREATE TABLE erasure_tombstones (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  ident_hash text NOT NULL,
  erased_at timestamptz NOT NULL,
  erasure_id text NOT NULL,
  PRIMARY KEY (workspace_id, ident_hash)
);

ALTER TABLE erasure_tombstones ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_tombstones FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON erasure_tombstones
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- UPDATE is needed for the upsert when an identifier is erased again; rows are only ever changed
-- by that ON CONFLICT clause, never read or edited by a person.
GRANT SELECT, INSERT, UPDATE, DELETE ON erasure_tombstones TO am_app;
