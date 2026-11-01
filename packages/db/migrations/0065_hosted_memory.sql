-- Wave 4, Phase 21 (#340; agentic-autonomy §7): hosted agents keep a small, inspectable memory.
--
-- A hosted agent starts each run fresh. Memory is the agent's own working notes ("the Tuesday
-- issue goes out at 07:00"), written by the agent during a run or by a person, editable and
-- deletable by people. It is deliberately bounded (at most 50 notes and 10,000 characters per
-- agent, each note at most 1,000 characters) and must not hold personal data. Learnings (#311)
-- remain the evidence-backed store; memory is not a place for conclusions without evidence.
--
-- A hosted agent may also reference skill artifacts (published versions are put into its run
-- context), so hosted_agents gains a list of skill artifact ids.
ALTER TABLE hosted_agents ADD COLUMN skills text[] NOT NULL DEFAULT '{}';

CREATE TABLE hosted_agent_memory (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  agent_id text NOT NULL,
  text text NOT NULL CHECK (char_length(text) BETWEEN 1 AND 1000),
  -- Exactly one of the two: a run of the agent, or a person who wrote the note.
  created_by_run_id text,
  created_by_user_id text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES hosted_agents (workspace_id, agent_id) ON DELETE CASCADE,
  CHECK ((created_by_run_id IS NULL) <> (created_by_user_id IS NULL))
);

-- The run context reads an agent's notes newest first; deletion removes them with the agent.
CREATE INDEX hosted_agent_memory_agent ON hosted_agent_memory (workspace_id, agent_id, created_at DESC);

ALTER TABLE hosted_agent_memory ENABLE ROW LEVEL SECURITY;
ALTER TABLE hosted_agent_memory FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON hosted_agent_memory
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON hosted_agent_memory TO am_app;
