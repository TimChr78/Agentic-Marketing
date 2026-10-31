-- Wave 4, Phase 20 (#311; agentic-autonomy §6): learnings, conclusions with their evidence.
--
-- A learning is a short statement ("subject lines with a number win for this audience") with the
-- scope it applies to and the experiments that back it. Agents read the active ones as the MCP
-- resource learnings://current and may add their own (as drafts, with evidence that points at a
-- real experiment). A person can retract one with a reason; the row stays for the record.
CREATE TABLE learnings (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  statement text NOT NULL,
  scope jsonb NOT NULL DEFAULT '{}'::jsonb,
  evidence jsonb NOT NULL DEFAULT '[]'::jsonb,
  author_type text NOT NULL CHECK (author_type IN ('user', 'agent')),
  author_id text NOT NULL,
  agent_id text,
  status text NOT NULL DEFAULT 'active' CHECK (status IN ('active', 'retracted')),
  retracted_by text,
  retracted_at timestamptz,
  retract_reason text,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);
CREATE INDEX learnings_active ON learnings (workspace_id, created_at DESC) WHERE status = 'active';

ALTER TABLE learnings ENABLE ROW LEVEL SECURITY;
ALTER TABLE learnings FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON learnings
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON learnings TO am_app;
