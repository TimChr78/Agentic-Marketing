-- am:no-transaction
-- The batch's "does this person already have this broadcast's message" lookup (#944).
--
-- A broadcast run asks that question for the members of every batch, after resolving each member to
-- the person it will reach. The only existing index on that shape is (workspace_id, journey_id,
-- status): it finds the broadcast's rows but not one person's, so a batch read every message the
-- broadcast ever wrote (or, through (workspace_id, profile_id, sent_at), every message each of the
-- 200 people ever received). This one answers it with one index entry per recipient of the
-- broadcast: measured on 20,000 recipients with 30 other messages each, a batch went from an index
-- scan that read 6,400 rows (32 ms) to an index-only scan of the 1,200 matching entries (2 ms).
--
-- Partial like the query: only real sends have a journey id and are not test sends. The migration
-- is non-transactional because CONCURRENTLY keeps writes flowing on a large messages table; the
-- statement is idempotent so an interrupted build can be retried safely.
CREATE INDEX CONCURRENTLY IF NOT EXISTS messages_journey_recipient
  ON messages (workspace_id, journey_id, profile_id)
  WHERE journey_id IS NOT NULL AND test = false;

-- The holdout reads walk a person's merge chain backwards (`merged_into`), which has no index: the
-- only index on the column family is `profiles_recent` (workspace, last_seen) and it excludes
-- tombstones, exactly the rows this walk needs. An assignment lookup per send/report entry is a
-- sequential scan of the workspace's profiles without it (#944).
CREATE INDEX CONCURRENTLY IF NOT EXISTS profiles_merged_into
  ON profiles (workspace_id, merged_into)
  WHERE merged_into IS NOT NULL;
