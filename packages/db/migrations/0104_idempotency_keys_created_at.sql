-- am:no-transaction
-- Idempotency-key retention (#976). The replay lookup ignores a key older than
-- RETENTION_IDEMPOTENCY_DAYS and the scheduler cleanup deletes those rows in batches, selecting
-- `created_at < cutoff ORDER BY created_at LIMIT …`. That ordered LIMIT needs an index on
-- created_at; on a busy install `idempotency_keys` has one row per keyed write and is large, so
-- the index is built CONCURRENTLY, outside BEGIN/COMMIT, and the migrator records the file only
-- after every statement succeeds. The statement is idempotent, so an interrupted build can be
-- retried safely.
--
-- (workspace_id, key) are appended so the batch's row lookup is index-only; the primary key
-- (workspace_id, key) still answers the per-key replay lookup with its own created_at filter.
CREATE INDEX CONCURRENTLY IF NOT EXISTS idempotency_keys_created_at
  ON idempotency_keys (created_at, workspace_id, key);
