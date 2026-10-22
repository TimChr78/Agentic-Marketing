-- Broadcasts (pilot): one run per published broadcast artifact. The scheduler claims due runs
-- with a lease and works through the segment's members in profile-id order; sends are keyed by
-- (broadcast, profile), so a run that is picked up again after a crash sends nobody twice.
CREATE TABLE broadcast_runs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  broadcast_id text NOT NULL,
  version integer NOT NULL,
  status text NOT NULL CHECK (status IN ('scheduled', 'running', 'done', 'cancelled', 'failed')),
  send_at timestamptz NOT NULL,
  lease_until timestamptz,
  cursor text NOT NULL DEFAULT '',
  recipients integer NOT NULL DEFAULT 0,
  queued integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  error text,
  started_at timestamptz,
  finished_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, broadcast_id)
);
CREATE INDEX broadcast_runs_due ON broadcast_runs (send_at) WHERE status IN ('scheduled', 'running');

ALTER TABLE broadcast_runs ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_runs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broadcast_runs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_runs TO am_app;
