-- Subject-test variant on a message (A, B, …), so reporting can break results down by variant
-- without joining Postgres. Older rows default to '' and are reported outside a test.
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS variant LowCardinality(String) AFTER journey_id;
