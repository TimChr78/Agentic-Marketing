-- am:no-transaction
-- The expired-hold sweeper (#1080) asks, for every expired live reservation,
-- `NOT EXISTS (SELECT 1 FROM ai_calls c WHERE c.reservation_id = r.id)`. Without an index that
-- check reads the whole ai_calls table for each candidate hold. This partial index covers only
-- rows that name a hold, which is exactly the lookup, and leaves the many finished calls out.
-- Built CONCURRENTLY so a populated ai_calls table keeps accepting writes while it is created; the
-- migrator runs this file outside BEGIN/COMMIT because CREATE INDEX CONCURRENTLY refuses a
-- transaction.
CREATE INDEX CONCURRENTLY IF NOT EXISTS ai_calls_reservation_id
  ON ai_calls (reservation_id)
  WHERE reservation_id IS NOT NULL;
