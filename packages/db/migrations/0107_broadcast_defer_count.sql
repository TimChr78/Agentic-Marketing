-- Fair scheduling for deferred broadcast runs (#978 part 2 review).
--
-- A run that waits for outbox publication is rescheduled a few seconds later. Without a counter
-- the wait is always the same, and the unordered due-run selection can pick the same stalled runs
-- every tick while an unrelated broadcast waits behind them. `defer_count` grows the publication
-- wait (2 s doubling to a 60 s cap) and is reset when a decision proceeds.
ALTER TABLE broadcast_runs ADD COLUMN IF NOT EXISTS defer_count integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN broadcast_runs.defer_count IS
  'Consecutive publication deferrals; the next wait doubles from 2 s to a 60 s cap (#978 part 2).';
