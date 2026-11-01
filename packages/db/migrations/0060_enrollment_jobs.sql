-- Phase 20 (#148): chunked, resumable journey enrollment by segment.
--
-- A job is the visible record of a deliberate backfill: which journey and segment, how many
-- people it may try (limit), how far it got (cursor, the last profile id scanned), what it did
-- (entered/skipped/failed and why people were skipped) and who asked for it. The scheduler
-- processes one chunk per tick in its own transaction, so a crash resumes from the cursor and
-- never enrolls the same person twice.
CREATE TABLE enrollment_jobs (
  workspace_id uuid NOT NULL REFERENCES workspaces (id) ON DELETE CASCADE,
  id text NOT NULL,
  journey_id text NOT NULL,
  segment_id text NOT NULL,
  status text NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'running', 'done', 'failed', 'cancelled')),
  "limit" integer CHECK ("limit" IS NULL OR "limit" > 0),
  cursor text,
  people integer NOT NULL DEFAULT 0,
  entered integer NOT NULL DEFAULT 0,
  skipped integer NOT NULL DEFAULT 0,
  failed integer NOT NULL DEFAULT 0,
  skip_reasons jsonb NOT NULL DEFAULT '{}'::jsonb,
  requested_by_type text NOT NULL CHECK (requested_by_type IN ('user', 'agent')),
  requested_by_id text NOT NULL,
  reason text NOT NULL,
  idempotency_key text,
  error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  started_at timestamptz,
  finished_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (workspace_id, id)
);

-- The same key returns the same job, so a retried request cannot start a second run.
CREATE UNIQUE INDEX enrollment_jobs_idempotency
  ON enrollment_jobs (workspace_id, idempotency_key)
  WHERE idempotency_key IS NOT NULL;

-- The scheduler's queue: only unfinished jobs matter.
CREATE INDEX enrollment_jobs_pending
  ON enrollment_jobs (created_at)
  WHERE status IN ('queued', 'running');

CREATE INDEX enrollment_jobs_journey
  ON enrollment_jobs (workspace_id, journey_id, created_at DESC);

ALTER TABLE enrollment_jobs ENABLE ROW LEVEL SECURITY;
ALTER TABLE enrollment_jobs FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON enrollment_jobs
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

GRANT SELECT, INSERT, UPDATE ON enrollment_jobs TO am_app;
