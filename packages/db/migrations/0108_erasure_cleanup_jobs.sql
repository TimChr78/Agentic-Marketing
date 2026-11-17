-- Durable erasure cleanup (#978 part 2b).
--
-- `profiles.erase` commits one SQL transaction that removes the person's rows and writes one row
-- here. The external stores (ClickHouse events, the decision API's hot state) are then cleaned up
-- by a scheduler job, outside any transaction, with a lease and a claim token. A process that dies
-- after the SQL commit leaves a due row that another worker claims; one that dies after deleting
-- from a store before acknowledging it leaves a checkpoint, so the rerun skips work that already
-- happened (the deletions are idempotent anyway).
--
-- The selectors name the erased person's anonymous and user ids. They are stored sealed with a
-- per-erasure service key wrapped by the configured KEK, never with the person's own key (which
-- the same transaction destroys), and both are purged when the job completes. `profile_ids` stays
-- plain: it is pseudonymous, and the completion barrier needs it to find the person's undelivered
-- outbox rows.
CREATE TABLE IF NOT EXISTS erasure_cleanup_jobs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  erasure_id text NOT NULL,
  profile_ids text[] NOT NULL,
  state text NOT NULL DEFAULT 'pending_external'
    CHECK (state IN ('pending_external', 'running', 'complete', 'failed')),
  attempts integer NOT NULL DEFAULT 0,
  next_attempt_at timestamptz NOT NULL DEFAULT now(),
  lease_until timestamptz,
  -- The token of the current claim. Completion, checkpoints and failures only apply while it
  -- matches, so a worker whose lease expired cannot overwrite the new owner's result.
  claim_token text,
  -- Per-store checkpoints: a rerun after a crash skips a store that already succeeded.
  clickhouse_done boolean NOT NULL DEFAULT false,
  hotstate_done boolean NOT NULL DEFAULT false,
  -- Anonymous and user ids, sealed with the per-erasure service key below. Null once complete.
  selectors bytea,
  selector_key bytea,
  selector_kek text,
  -- A bounded, sanitised reason the last attempt failed; operators read it with `am doctor`.
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  PRIMARY KEY (workspace_id, erasure_id)
);

-- The cleanup worker claims only rows that are due, and a crashed worker's row once its lease
-- expires. Completed rows stay as the erasure's status record.
CREATE INDEX IF NOT EXISTS erasure_cleanup_ready ON erasure_cleanup_jobs (next_attempt_at, created_at)
  WHERE state IN ('pending_external', 'running');
-- The completion barrier and `pruneErasureKeys` ask which jobs for a profile are still open.
CREATE INDEX IF NOT EXISTS erasure_cleanup_open_profiles ON erasure_cleanup_jobs USING gin (profile_ids)
  WHERE state <> 'complete';

ALTER TABLE erasure_cleanup_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_cleanup_jobs FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON erasure_cleanup_jobs;
CREATE POLICY tenant_isolation ON erasure_cleanup_jobs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE, DELETE ON erasure_cleanup_jobs TO am_app;

COMMENT ON TABLE erasure_cleanup_jobs IS
  'Durable external cleanup for one erasure (#978 part 2b): ClickHouse events and hot state, retried with a lease.';
COMMENT ON COLUMN erasure_cleanup_jobs.state IS
  'pending_external (due), running (claimed), complete, or failed after its retry budget.';
COMMENT ON COLUMN erasure_cleanup_jobs.claim_token IS
  'Token of the current claim; completion, checkpoints and failure only apply while it matches.';
COMMENT ON COLUMN erasure_cleanup_jobs.selectors IS
  'Anonymous and user ids sealed with the per-erasure service key; purged when the job completes.';
COMMENT ON COLUMN erasure_cleanup_jobs.selector_key IS
  'The per-erasure service key, wrapped by the configured KEK; never the erased person''s key.';
