-- 0.2.7 (issue #111): SVG logos are accepted after sanitising, and e-mail gets a PNG rendition.
-- assets.content_type gains image/svg+xml; asset_renditions stores the rasterised PNG next to the
-- original so hosted pages keep the crisp SVG and e-mail clients (which do not render SVG) get PNG.

ALTER TABLE assets DROP CONSTRAINT IF EXISTS assets_content_type_check;
ALTER TABLE assets ADD CONSTRAINT assets_content_type_check CHECK (
  content_type IN ('image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/svg+xml', 'application/pdf')
);

CREATE TABLE asset_renditions (
  workspace_id uuid NOT NULL,
  asset_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('png')),
  content_type text NOT NULL CHECK (content_type IN ('image/png')),
  byte_size integer NOT NULL CHECK (byte_size > 0),
  sha256 text NOT NULL,
  width integer NOT NULL CHECK (width > 0),
  height integer NOT NULL CHECK (height > 0),
  data bytea NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, asset_id, kind),
  FOREIGN KEY (workspace_id, asset_id) REFERENCES assets (workspace_id, id) ON DELETE CASCADE
);

ALTER TABLE asset_renditions ENABLE ROW LEVEL SECURITY;
ALTER TABLE asset_renditions FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON asset_renditions
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON asset_renditions TO am_app;
