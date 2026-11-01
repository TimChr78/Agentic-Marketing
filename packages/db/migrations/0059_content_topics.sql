-- Wave 4, Phase 20 (#141): the editorial topic backlog.
--
-- A topic is a workspace-scoped backlog row: idea → scored → brief → approved → drafting →
-- published, with an archive at any point. It carries the signals that surface it (source items,
-- community demand, manual ideas), a score, dedupe key and links to similar topics. Briefs are
-- artifacts (content_brief), so they keep their own versions and approval flow; a topic only
-- stores the id of its brief and the published URL.
CREATE TABLE content_topics (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  title text NOT NULL,
  angle text NOT NULL DEFAULT '',
  audience text NOT NULL DEFAULT '',
  reader_role text NOT NULL DEFAULT '',
  keyword text,
  tags text[] NOT NULL DEFAULT '{}',
  status text NOT NULL DEFAULT 'idea' CHECK (status IN ('idea', 'scored', 'brief', 'approved', 'drafting', 'published', 'archived')),
  score integer NOT NULL DEFAULT 0 CHECK (score >= 0 AND score <= 100),
  signals jsonb NOT NULL DEFAULT '[]'::jsonb,
  owner_id text,
  owner_name text,
  target_date date,
  canonical_url text,
  campaign_id text,
  broadcast_id text,
  dedupe_key text NOT NULL,
  similar_topic_ids text[] NOT NULL DEFAULT '{}',
  brief_artifact_id text,
  created_by_type text NOT NULL CHECK (created_by_type IN ('user', 'agent')),
  created_by_id text NOT NULL,
  agent_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

CREATE INDEX content_topics_status ON content_topics (workspace_id, status, score DESC);
CREATE INDEX content_topics_dedupe ON content_topics (workspace_id, dedupe_key) WHERE status <> 'archived';
CREATE INDEX content_topics_owner ON content_topics (workspace_id, owner_id);

ALTER TABLE content_topics ENABLE ROW LEVEL SECURITY;
ALTER TABLE content_topics FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON content_topics
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- Archived topics keep their row, brief and URL: nothing is deleted, so no DELETE grant.
GRANT SELECT, INSERT, UPDATE ON content_topics TO am_app;
