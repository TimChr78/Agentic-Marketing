-- Staged sends (#254): a canary share goes first, is checked after a wait, and only then does the
-- rest go out — or the run stops.
--
-- The stage row is the durable state machine, keyed like the run and the subject test. It keeps
-- the canary's own counts and the rates seen at check time, so broadcasts.status can explain a
-- stop long after the run ended. The run's cursor is reset when the canary finishes and when a
-- person resumes after a stop, so the rest pass rebuilds the audience from the top.
CREATE TABLE broadcast_stages (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  broadcast_id text NOT NULL,
  stage text NOT NULL CHECK (stage IN ('canary_sending', 'canary_waiting', 'checking', 'sending_rest', 'stopped', 'done')),
  canary_percent integer NOT NULL,
  -- The first canary send plus the configured wait; the run's lease wakes it then.
  check_at timestamptz,
  checked_at timestamptz,
  -- Fewer canary sends than minCanary: the rates are too small to judge, so the rest goes out.
  check_skipped boolean NOT NULL DEFAULT false,
  canary_recipients integer NOT NULL DEFAULT 0,
  canary_queued integer NOT NULL DEFAULT 0,
  canary_skipped integer NOT NULL DEFAULT 0,
  -- Base counts from the canary's message events at check time.
  sent integer NOT NULL DEFAULT 0,
  bounced integer NOT NULL DEFAULT 0,
  complained integer NOT NULL DEFAULT 0,
  unsubscribed integer NOT NULL DEFAULT 0,
  bounce_rate double precision,
  complaint_rate double precision,
  unsubscribe_rate double precision,
  stop_reason text,
  stopped_at timestamptz,
  -- A person sent the rest after a stop (broadcasts.continue).
  resumed_at timestamptz,
  completed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, broadcast_id)
);

ALTER TABLE broadcast_stages ENABLE ROW LEVEL SECURITY;
ALTER TABLE broadcast_stages FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON broadcast_stages
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);
GRANT SELECT, INSERT, UPDATE, DELETE ON broadcast_stages TO am_app;

-- A stopped staged run is a terminal state of its own: the rest waits for a person, and the
-- scheduler must not pick the run up again.
ALTER TABLE broadcast_runs DROP CONSTRAINT broadcast_runs_status_check;
ALTER TABLE broadcast_runs ADD CONSTRAINT broadcast_runs_status_check
  CHECK (status IN ('scheduled', 'running', 'done', 'cancelled', 'failed', 'stopped'));
