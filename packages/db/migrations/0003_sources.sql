-- Event sources (data-platform.md §2). Browser sources have a public write key and an origin
-- allow-list; server sources have a secret key. Only key hashes are used for lookups; the public
-- key of a browser source is also kept so the UI can show the snippet again.
CREATE TABLE sources (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('browser', 'server')),
  key_hash text NOT NULL UNIQUE,
  public_key text,
  key_hint text NOT NULL,
  allowed_origins text[] NOT NULL DEFAULT '{}',
  required_purpose text,
  enabled boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

ALTER TABLE sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON sources
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON sources TO am_app;
