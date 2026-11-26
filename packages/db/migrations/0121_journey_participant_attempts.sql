-- 0.17.8 (#1240): the journey sweep fails a participant only after retries are exhausted.
--
-- The sweep treated every rejection from `advance` as a broken condition and moved the participant
-- to the terminal `failed` state on the first transient event-store error (a ClickHouse restart, a
-- timeout under load). This counter records how many times the advance was retried; it is reset on
-- a successful step, and the participant fails only when the budget is spent, matching the
-- `active --> failed: retries exhausted` transition in docs/architecture/journeys-and-editors.md.
ALTER TABLE journey_participants ADD COLUMN IF NOT EXISTS attempts integer NOT NULL DEFAULT 0;

COMMENT ON COLUMN journey_participants.attempts IS
  'Consecutive failed advances of the current step; reset on success, and the participant fails when the retry budget is spent (#1240).';
