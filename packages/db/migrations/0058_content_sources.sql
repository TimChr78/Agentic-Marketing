-- Wave 4, Phase 20 (#140): workspace-owned content sources, a normalised article library, and
-- versioned selections for an issue or brief.
--
-- A source is RSS, Atom or JSON Feed configuration with its fetch state. Items are normalised
-- articles: an excerpt and the canonical link, never the full article. A selection is a named,
-- dated snapshot of item ids per section, so pruning the library never changes history.
CREATE TABLE content_sources (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('rss', 'atom', 'json')),
  url text NOT NULL,
  name text NOT NULL,
  category text NOT NULL DEFAULT 'other'
    CHECK (category IN ('platform', 'publication', 'vendor', 'community', 'open source', 'thought leader', 'other')),
  authority integer NOT NULL DEFAULT 3 CHECK (authority BETWEEN 1 AND 5),
  language text NOT NULL DEFAULT 'en',
  enabled boolean NOT NULL DEFAULT true,
  fetch_interval_minutes integer NOT NULL DEFAULT 360 CHECK (fetch_interval_minutes > 0),
  last_fetch_at timestamptz,
  etag text,
  last_modified text,
  last_error text,
  consecutive_failures integer NOT NULL DEFAULT 0,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, url)
);

CREATE INDEX content_sources_due ON content_sources (workspace_id, enabled, last_fetch_at);

ALTER TABLE content_sources ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_sources FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_sources
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON content_sources TO am_app;

CREATE TABLE content_items (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  source_id text NOT NULL,
  canonical_url text NOT NULL,
  title text NOT NULL,
  excerpt text NOT NULL,
  author text,
  published_at timestamptz,
  fetched_at timestamptz NOT NULL,
  last_seen_at timestamptz NOT NULL,
  dedupe_key text NOT NULL,
  title_key text NOT NULL,
  language text NOT NULL DEFAULT 'en',
  section text NOT NULL,
  status text NOT NULL DEFAULT 'new' CHECK (status IN ('new', 'selected', 'ignored', 'used')),
  relevance_score integer NOT NULL DEFAULT 0,
  score_explanation jsonb NOT NULL DEFAULT '{}'::jsonb,
  policy_version text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, dedupe_key),
  FOREIGN KEY (workspace_id, source_id) REFERENCES content_sources (workspace_id, id) ON DELETE CASCADE
);

CREATE INDEX content_items_source ON content_items (workspace_id, source_id);
CREATE INDEX content_items_recent ON content_items (workspace_id, fetched_at DESC);
CREATE INDEX content_items_score ON content_items (workspace_id, relevance_score DESC);
CREATE INDEX content_items_title ON content_items (workspace_id, title_key);

ALTER TABLE content_items ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_items FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_items
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON content_items TO am_app;

CREATE TABLE content_selections (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  name text NOT NULL,
  issue_date date NOT NULL,
  version integer NOT NULL DEFAULT 1 CHECK (version > 0),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'approved')),
  sections jsonb NOT NULL DEFAULT '[]'::jsonb,
  policy_version text NOT NULL,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  UNIQUE (workspace_id, name, version)
);

CREATE INDEX content_selections_recent ON content_selections (workspace_id, issue_date DESC);

ALTER TABLE content_selections ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_selections FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_selections
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON content_selections TO am_app;
