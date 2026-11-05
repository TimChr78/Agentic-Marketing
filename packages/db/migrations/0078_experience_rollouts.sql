-- Progressive rollout for agent changes (#427, part of #102). A published experience can carry a
-- ramp in its content (`rollout`); this table keeps the step it is on, the share served now and the
-- last guardrail reading, so the edge bundle and the decision API need no recalculation. One row per
-- published experience, replaced when a new version is published.
CREATE TABLE experience_rollouts (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  -- The published version this state belongs to; a stale row is ignored after a new publish.
  version integer NOT NULL,
  steps integer[] NOT NULL,
  step_hours integer NOT NULL,
  step_index integer NOT NULL DEFAULT 0,
  -- Current share of eligible visitors (0–100), mirrored into the edge bundle.
  share integer NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'running' CHECK (status IN ('running', 'paused', 'stopped', 'complete')),
  -- The ramp's guardrail definition from the experience content, and its latest metric-layer reading.
  guardrail jsonb,
  last_guardrail jsonb,
  started_at timestamptz NOT NULL DEFAULT now(),
  advanced_at timestamptz NOT NULL DEFAULT now(),
  next_step_at timestamptz,
  paused_at timestamptz,
  stopped_at timestamptz,
  reason text,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text,
  PRIMARY KEY (workspace_id, artifact_id),
  CONSTRAINT experience_rollouts_share CHECK (share >= 0 AND share <= 100),
  CONSTRAINT experience_rollouts_step_index CHECK (step_index >= 0)
);

-- The scheduler finds due ramps without scanning stopped or completed ones.
CREATE INDEX experience_rollouts_due ON experience_rollouts (next_step_at) WHERE status = 'running';

ALTER TABLE experience_rollouts ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_rollouts FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON experience_rollouts
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON experience_rollouts TO am_app;

-- The agent event sweep reads pauses from this table; the cursor keeps each pause delivered once.
ALTER TABLE agent_event_cursor ADD COLUMN last_rollout_at timestamptz;

COMMENT ON TABLE experience_rollouts IS
  'Progressive rollout state for a published experience (#427): current step, share, guardrail reading and stop reason.';
