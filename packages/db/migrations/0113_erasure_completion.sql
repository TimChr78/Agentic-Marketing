-- Erasure completion and the recurring physical purge (#1037, 0.17.0 part 3).
--
-- `profiles.erasureStatus` reports logical completion separately from physical deletion. A job may
-- only complete when its ledger is published and visible, and the workspace has no person-linked
-- rows that protected reads cannot check (the subject-key coverage count is zero). The gate is
-- recorded on the job, so completion is an explicit state, not an inference from a sweep.
ALTER TABLE erasure_cleanup_jobs ADD COLUMN IF NOT EXISTS coverage_cleared_at timestamptz;
ALTER TABLE erasure_cleanup_jobs ADD COLUMN IF NOT EXISTS completion_reason text;

COMMENT ON COLUMN erasure_cleanup_jobs.coverage_cleared_at IS
  'When a FINAL subject-key coverage count reached zero for the workspace; completion requires it (#1037 part 3).';
COMMENT ON COLUMN erasure_cleanup_jobs.completion_reason IS
  'Why a pending or running job has not completed yet: publication, outbox, final_sweep or subject_key_coverage.';

-- Physical purge progress is per workspace, because one sweep covers every erasure key the
-- workspace retains. `purged_generation` is the publication generation whose keys the last
-- completed sweep covered; `generation` moves when a new exclusion is published, so a later
-- publication is a new purge obligation. Late rows keep arriving; the scheduler re-sweeps at a low
-- frequency and updates `purge_last_sweep_at` without pretending the data is gone forever.
ALTER TABLE erasure_generations ADD COLUMN IF NOT EXISTS purged_generation bigint NOT NULL DEFAULT 0;
ALTER TABLE erasure_generations ADD COLUMN IF NOT EXISTS purge_last_sweep_at timestamptz;
ALTER TABLE erasure_generations ADD COLUMN IF NOT EXISTS purge_deleted_rows bigint NOT NULL DEFAULT 0;
ALTER TABLE erasure_generations ADD COLUMN IF NOT EXISTS purge_claim_token text;
ALTER TABLE erasure_generations ADD COLUMN IF NOT EXISTS purge_lease_until timestamptz;

COMMENT ON COLUMN erasure_generations.purged_generation IS
  'The publication generation whose exclusion keys the last completed physical sweep covered (#1037 part 3).';
COMMENT ON COLUMN erasure_generations.purge_last_sweep_at IS
  'When the last physical purge sweep of this workspace finished; a recent value is not proof that late rows never arrive.';
COMMENT ON COLUMN erasure_generations.purge_deleted_rows IS
  'Rows physically deleted by the recurring purge since this counter was introduced; display only.';
COMMENT ON COLUMN erasure_generations.purge_claim_token IS
  'Fences physical purge progress: only the claim holding this token may record its result.';
COMMENT ON COLUMN erasure_generations.purge_lease_until IS
  'How long a worker may hold the workspace purge claim before another may take it over.';
