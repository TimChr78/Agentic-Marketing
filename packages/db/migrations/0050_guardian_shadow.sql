-- Wave 4, Phase 19 (#253, #256; ADR-0016): the guardian and shadow mode.
--
-- The guardian watches agents with an active mandate and can cap an agent's levels without a person
-- (`guard`: {cap, irreversibleCap, reason, since, episodeId}); the policy engine applies the cap on
-- top of the mandate and the workspace ceilings until a person clears it. Each time the guardian
-- acts it records an episode with its evidence.
ALTER TABLE agents ADD COLUMN guard jsonb;

CREATE TABLE guardian_events (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  agent_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('guardrail', 'anomaly', 'probing', 'loop', 'errors')),
  action text NOT NULL CHECK (action IN ('cap', 'hold', 'pause')),
  reason text NOT NULL,
  evidence jsonb NOT NULL DEFAULT '{}'::jsonb,
  suspended_holds integer NOT NULL DEFAULT 0,
  at timestamptz NOT NULL DEFAULT now(),
  cleared_at timestamptz,
  cleared_by text,
  cleared_note text,
  PRIMARY KEY (workspace_id, id),
  FOREIGN KEY (workspace_id, agent_id) REFERENCES agents (workspace_id, id) ON DELETE CASCADE
);
CREATE INDEX guardian_events_agent ON guardian_events (workspace_id, agent_id, at DESC);

-- Shadow mode (#256): what the mandate would have decided, while a person decided as before.
ALTER TABLE agent_actions ADD COLUMN shadow jsonb;

ALTER TABLE guardian_events ENABLE ROW LEVEL SECURITY;
ALTER TABLE guardian_events FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON guardian_events
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON guardian_events TO am_app;
