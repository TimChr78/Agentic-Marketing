-- Wave 2, Phase 10: warehouse export. Each destination (a Postgres database, or S3-compatible
-- storage that BigQuery, Snowflake and others load from) receives the workspace's pseudonymous
-- data on a schedule: profiles without personal data, user and anonymous ids, consent, segment
-- memberships, events and message events, and erasures so the warehouse can forget people too.
-- `cursors` holds how far each dataset has been exported.
CREATE TABLE warehouse_exports (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('postgres', 's3')),
  config jsonb NOT NULL DEFAULT '{}',
  secrets bytea,
  secrets_key_id text,
  datasets text[] NOT NULL,
  every_minutes integer NOT NULL DEFAULT 60 CHECK (every_minutes BETWEEN 5 AND 10080),
  enabled boolean NOT NULL DEFAULT true,
  cursors jsonb NOT NULL DEFAULT '{}',
  run_requested boolean NOT NULL DEFAULT false,
  last_run_at timestamptz,
  last_status text CHECK (last_status IN ('ok', 'failed')),
  last_error text,
  last_counts jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

ALTER TABLE warehouse_exports ENABLE ROW LEVEL SECURITY;
ALTER TABLE warehouse_exports FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON warehouse_exports
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON warehouse_exports TO am_app;
