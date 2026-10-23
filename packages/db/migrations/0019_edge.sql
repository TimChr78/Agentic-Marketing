-- Wave 2, Phase 11: decisions at the edge. A workspace can mirror what the decision API needs to
-- Cloudflare Workers KV (experiences, write keys and purposes as one bundle; profile snapshots as
-- they change, deletions included), where a Worker answers /v1/decide next to the visitor.
-- Snapshot writes queue in edge_outbox and go up in bulk.
CREATE TABLE edge_targets (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  provider text NOT NULL DEFAULT 'cloudflare' CHECK (provider = 'cloudflare'),
  account_id text NOT NULL,
  namespace_id text NOT NULL,
  api_base text,
  secrets bytea,
  secrets_key_id text,
  snapshots boolean NOT NULL DEFAULT true,
  enabled boolean NOT NULL DEFAULT true,
  bundle_hash text,
  pushed_keys text[] NOT NULL DEFAULT '{}',
  backfill_cursor text,
  last_sync_at timestamptz,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE edge_outbox (
  id bigserial PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  key text NOT NULL,
  value jsonb,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX edge_outbox_ws ON edge_outbox (workspace_id, id);

ALTER TABLE edge_targets ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_targets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON edge_targets
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE edge_outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE edge_outbox FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON edge_outbox
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON edge_targets, edge_outbox TO am_app;
GRANT USAGE ON SEQUENCE edge_outbox_id_seq TO am_app;
