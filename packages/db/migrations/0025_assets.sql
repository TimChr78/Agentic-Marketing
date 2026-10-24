-- Asset library (issue #35): small images and PDFs for e-mails and hosted pages. Asset metadata
-- is listed without touching bytes; asset_blobs keeps the file itself so listings stay cheap.

CREATE TABLE assets (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  file_name text NOT NULL,
  content_type text NOT NULL CHECK (
    content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'application/pdf')
  ),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL,
  width integer,
  height integer,
  alt_text text NOT NULL DEFAULT '',
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  deleted_at timestamptz,
  PRIMARY KEY (workspace_id, id),
  -- Public links look an asset up by id alone, without a workspace.
  UNIQUE (id),
  CHECK ((width IS NULL) = (height IS NULL))
);
CREATE INDEX assets_recent ON assets (workspace_id, created_at DESC, id DESC) WHERE deleted_at IS NULL;

CREATE TABLE asset_blobs (
  workspace_id uuid NOT NULL,
  asset_id text NOT NULL,
  data bytea NOT NULL,
  PRIMARY KEY (workspace_id, asset_id),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE assets ENABLE ROW LEVEL SECURITY;
ALTER TABLE assets FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON assets
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
ALTER TABLE asset_blobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_blobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_blobs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON assets, asset_blobs TO am_app;
