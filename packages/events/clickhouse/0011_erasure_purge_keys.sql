-- The physical purge's per-run key set (#1037 part 3).
--
-- A sweep must match the exact, full-coverage exclusion-key list PostgreSQL committed for the
-- workspace, and a ledger can be far larger than one HTTP query parameter may carry
-- (`http_max_field_value_size`, #1205). Each sweep therefore stages its key set here, in bounded
-- batches, under a fresh `run_id`, and every purge statement reads the set from this table:
--
--   ... IN (SELECT key FROM erasure_purge_keys WHERE workspace_id = {ws:UUID} AND run_id = {run:String})
--
-- ClickHouse builds that as a hash set once per statement, so the purge keeps set-membership
-- performance without ever sending the ledger to the server as a parameter. `run_id` makes
-- concurrent sweeps (two replicas, or a retry) independent: a sweep reads only its own rows.
--
-- The rows are transport state, not ledger state. The sweep deletes its run's rows when it ends,
-- and the TTL is a backstop for a crash between the last statement and that delete; nothing reads
-- an abandoned run id after that.
CREATE TABLE IF NOT EXISTS erasure_purge_keys (
  workspace_id UUID,
  run_id String,
  key String,
  created_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = MergeTree
ORDER BY (workspace_id, run_id, key)
TTL toDateTime(created_at) + INTERVAL 1 DAY
