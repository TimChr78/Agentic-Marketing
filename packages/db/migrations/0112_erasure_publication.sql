-- Durable publication of erasure exclusions (#1037, 0.17.0 part 2).
--
-- `erasure_keys` is the ledger the erasure's SQL stage commits; `erased_subjects` in ClickHouse is
-- what protected reads match against. This table is the per-workspace publication generation the
-- ClickHouse state is written under. It only ever moves forward, so a replay can never make a
-- later exclusion look older than one already published. A restore carries it with the erasure
-- log and applies the larger value, because a snapshot taken before a publication has a lower
-- counter than the ClickHouse table it is restored next to.
CREATE TABLE IF NOT EXISTS erasure_generations (
  workspace_id uuid PRIMARY KEY REFERENCES workspaces (id) ON DELETE CASCADE,
  generation bigint NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now()
);

ALTER TABLE erasure_generations ENABLE ROW LEVEL SECURITY;
ALTER TABLE erasure_generations FORCE ROW LEVEL SECURITY;
DROP POLICY IF EXISTS tenant_isolation ON erasure_generations;
CREATE POLICY tenant_isolation ON erasure_generations
  USING (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid)
  WITH CHECK (workspace_id = nullif(current_setting('app.workspace_id', true), '')::uuid);

-- UPDATE is the atomic `generation = generation + 1`; nothing else changes a row.
GRANT SELECT, INSERT, UPDATE ON erasure_generations TO am_app;

COMMENT ON TABLE erasure_generations IS
  'Per-workspace, monotonically increasing generation the ClickHouse erased-subjects state is published under (#1037).';
COMMENT ON COLUMN erasure_generations.generation IS
  'The last publication generation. Only ever increases; a restore applies the larger of the snapshot and the live log.';

-- What the cleanup job published, and when. NULL means "not published yet" and is what makes a
-- restored or retried job publish again; 0 means the erasure had no full-coverage ledger row, so
-- there was nothing to publish. Completion does not depend on this yet: part 3 makes it the gate.
ALTER TABLE erasure_cleanup_jobs ADD COLUMN IF NOT EXISTS published_generation bigint;
ALTER TABLE erasure_cleanup_jobs ADD COLUMN IF NOT EXISTS published_at timestamptz;

COMMENT ON COLUMN erasure_cleanup_jobs.published_generation IS
  'The erasure_generations value this job published its ledger under; 0 when it had no full-coverage key.';
COMMENT ON COLUMN erasure_cleanup_jobs.published_at IS
  'When publication was confirmed by a FINAL read of erased_subjects; NULL means it still has to happen.';
