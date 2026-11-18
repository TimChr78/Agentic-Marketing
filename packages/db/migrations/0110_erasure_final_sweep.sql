-- Anchor the erasure cleanup's final re-sweep to the first cleanup claim (#1037 review).
--
-- The claim only sees a job after the erasure's SQL transaction committed, so the timestamp is a
-- post-commit observation. The old deadline was derived from the job's created_at, which the
-- erasure transaction wrote before it committed. A NULL value means the job has not been claimed
-- yet; the claim fills it once and every later claim (including a lease takeover) keeps it.
ALTER TABLE erasure_cleanup_jobs ADD COLUMN IF NOT EXISTS final_sweep_at timestamptz;

-- The successful first pass. The final pass may only run at least the sweep interval after this
-- checkpoint, so a failed (or outbox-delayed) first delete cannot be followed by a single
-- successful delete that completes the job. NULL until a ClickHouse delete succeeds.
ALTER TABLE erasure_cleanup_jobs ADD COLUMN IF NOT EXISTS first_sweep_done_at timestamptz;

COMMENT ON COLUMN erasure_cleanup_jobs.final_sweep_at IS
  'When the first cleanup claim observed the committed erasure; the post-commit anchor for the final sweep.';
COMMENT ON COLUMN erasure_cleanup_jobs.first_sweep_done_at IS
  'When the first ClickHouse delete succeeded; the final delete only runs at least the sweep interval after this.';
