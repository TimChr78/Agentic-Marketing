-- 0.2.6 (issue #106): agents may propose low-risk workspace settings (the name and display time
-- zone) but never administer them. A proposal is a small, reviewable diff a person approves in the
-- admin UI; it is not an artifact or an approval request, because neither row shape fits settings.
CREATE TABLE workspace_proposals (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  changes jsonb NOT NULL,
  note text NOT NULL,
  status text NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent')),
  requested_by_id text NOT NULL,
  requested_by_client text,
  decided_by text,
  decided_at timestamptz,
  decision_note text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX workspace_proposals_pending ON workspace_proposals (workspace_id, created_at DESC) WHERE status = 'pending';

ALTER TABLE workspace_proposals ENABLE ROW LEVEL SECURITY;
ALTER TABLE workspace_proposals FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workspace_proposals
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
-- No DELETE: superseding and deciding are UPDATEs, so the history stays.
GRANT SELECT, INSERT, UPDATE ON workspace_proposals TO am_app;
