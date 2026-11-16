-- AI budget accounting (#941): record when usage was billed, whether it was estimated, and the
-- reservation an attempt holds, so a crash cannot leave an untraceable hold and a call queued
-- before UTC month-end is counted in the month it was actually billed.
--
-- `billed_at` is set when the usage is settled; rows from before this column fall back to
-- `created_at`, so no backfill is needed. `usage_estimated` marks a call whose provider usage was
-- unknown (a failed structured answer or a crash) and that was settled at its reserved estimate
-- rather than zero. `reservation_id` ties the live hold to the ai_calls row, so a retry of the same
-- attempt can settle or clear the previous attempt's hold instead of holding twice.
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS billed_at timestamptz;
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS usage_estimated boolean NOT NULL DEFAULT false;
ALTER TABLE ai_calls ADD COLUMN IF NOT EXISTS reservation_id text;

-- A hold recovered after its attempt crashed is kept as an estimate until the attempt can replace
-- it with actual usage. `estimated_tokens` marks such a row: it no longer counts as a live hold,
-- and a later real settlement reconciles the estimate exactly once under the budget lock (#941
-- round 3).
ALTER TABLE ai_token_reservations ADD COLUMN IF NOT EXISTS estimated_tokens integer;

COMMENT ON COLUMN ai_token_reservations.estimated_tokens IS
  'The held tokens already recorded as an estimate after a crashed attempt; null for a live hold (#941).';

COMMENT ON COLUMN ai_calls.billed_at IS
  'When the call''s usage was settled; monthly budget accounting uses coalesce(billed_at, created_at) (#941).';
COMMENT ON COLUMN ai_calls.usage_estimated IS
  'True when the provider usage was unknown and the reserved estimate was recorded instead (#941).';
COMMENT ON COLUMN ai_calls.reservation_id IS
  'The budget hold this attempt created, so a retry can settle or clear a crashed attempt''s hold (#941).';
