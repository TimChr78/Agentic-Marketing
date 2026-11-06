-- Rollout fixes for 0.10.1 (#454, #473, #474, #476). Additive only.

-- Who stopped a ramp (#454): a person's stop is sticky across agent republishes, so the publish
-- hook has to tell them apart from an agent's own stop. An existing row predates the columns, so it
-- defaults to "a person stopped it", the safe reading.
ALTER TABLE experience_rollouts ADD COLUMN stopped_by text;
ALTER TABLE experience_rollouts ADD COLUMN stopped_by_agent boolean NOT NULL DEFAULT false;

-- The last error a ramp's guardrail read or step failed with (#474). The ramp keeps running and
-- waits; the error explains why its next_step_at is in the past without an advance.
ALTER TABLE experience_rollouts ADD COLUMN last_error text;

COMMENT ON COLUMN experience_rollouts.stopped_by IS
  'The person or agent that stopped the ramp (#454), kept across republishes the ramp stays stopped through.';
COMMENT ON COLUMN experience_rollouts.stopped_by_agent IS
  'True when an agent stopped the ramp: only a person-stopped ramp blocks an agent republish from restarting it.';
COMMENT ON COLUMN experience_rollouts.last_error IS
  'Why the last sweep could not advance this ramp (#474); cleared by the next successful step.';

-- A durable pause log (#473, #476). The pause commits with the ramp, so a later failure cannot roll
-- it back, and every consumer reads this row rather than the mutable rollout state: a stop after the
-- pause cannot erase a pause the owner e-mail or the agent event sweep has not delivered yet.
CREATE TABLE experience_rollout_pauses (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  artifact_id text NOT NULL,
  version integer NOT NULL,
  paused_at timestamptz NOT NULL,
  step_index integer NOT NULL,
  share integer NOT NULL,
  reason text,
  guardrail jsonb,
  -- The metric-layer reading that failed, kept for the e-mail and the event after the ramp moves on.
  reading jsonb,
  -- Set once the owner e-mail was attempted; null means the outbox still owes it.
  notified_at timestamptz,
  notify_error text,
  PRIMARY KEY (workspace_id, artifact_id, paused_at)
);

CREATE INDEX experience_rollout_pauses_pending ON experience_rollout_pauses (workspace_id, paused_at)
  WHERE notified_at IS NULL;
CREATE INDEX experience_rollout_pauses_cursor ON experience_rollout_pauses (workspace_id, paused_at);

-- A ramp that is paused at upgrade keeps its pending pause visible to the sweep and the e-mail
-- outbox; its owners already saw the old in-transaction e-mail, so it is marked as notified. This
-- runs before RLS is enabled, so the migration role is not filtered by a workspace setting.
INSERT INTO experience_rollout_pauses (
  workspace_id, artifact_id, version, paused_at, step_index, share, reason, guardrail, notified_at
)
SELECT workspace_id, artifact_id, version, paused_at, step_index, share, reason, guardrail, now()
  FROM experience_rollouts
 WHERE status = 'paused' AND paused_at IS NOT NULL
ON CONFLICT DO NOTHING;

ALTER TABLE experience_rollout_pauses ENABLE ROW LEVEL SECURITY;
ALTER TABLE experience_rollout_pauses FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON experience_rollout_pauses
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON experience_rollout_pauses TO am_app;

COMMENT ON TABLE experience_rollout_pauses IS
  'Durable record of each guardrail pause (#473, #476): the owner e-mail and the experience.rollout_paused agent event are delivered from it, once per pause.';

