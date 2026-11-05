-- Brand domains (#186, epic #184). A brand is a workspace; `workspace_domains` maps a public
-- hostname (and optional path prefix, for sites that proxy `/am`) to the workspace whose links it
-- serves. Resolution happens before a workspace is known, so the server reads this table on the
-- owner connection (like the archive lookup), never as am_app under a tenant setting.
--
-- `PUBLIC_LINKS_URL` stays the fallback: a workspace with no domain keeps exactly the links it has
-- today, and no row is backfilled from configuration because the URL lives in the environment.
CREATE TABLE workspace_domains (
  id text PRIMARY KEY,
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  -- Normalised lowercase IDNA hostname, no scheme, port or trailing dot.
  host text NOT NULL,
  -- Normalised leading-slash path prefix, or null for the whole host.
  path_prefix text,
  is_primary boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'verified')),
  verification_token text,
  verified_at timestamptz,
  created_by text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

-- One row per host and prefix across the whole installation: two brands cannot share a
-- hostname/prefix, which would make Host resolution ambiguous.
CREATE UNIQUE INDEX workspace_domains_host_prefix
  ON workspace_domains (host, COALESCE(path_prefix, ''));

CREATE INDEX workspace_domains_host ON workspace_domains (host);

-- One primary domain per workspace; its origin+prefix is the workspace's links URL.
CREATE UNIQUE INDEX workspace_domains_primary
  ON workspace_domains (workspace_id)
  WHERE is_primary;

ALTER TABLE workspace_domains ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_domains FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_domains
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON workspace_domains TO am_app;
