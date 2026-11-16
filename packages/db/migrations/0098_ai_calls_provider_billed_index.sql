-- am:no-transaction
-- The monthly/period usage reads filter and group by coalesce(billed_at, created_at) (#941 review).
-- Built CONCURRENTLY so a populated ai_calls table keeps accepting writes while the index is
-- created; the migrator runs this file outside BEGIN/COMMIT because CREATE INDEX CONCURRENTLY
-- refuses a transaction. The column changes stay in 0097, whose ALTER TABLE then holds its
-- exclusive lock only for the catalog updates.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_calls_provider_billed
  ON ai_calls (provider_id, (coalesce(billed_at, created_at)));
