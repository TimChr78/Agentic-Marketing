-- Caps age a completed contact from when the provider accepted it, not from when it was queued
-- (#453): a message that waited for quiet hours, a paused stream or a retry must consume the
-- recent-contact window from its real send time. Queued and in-flight reservations still age
-- from created_at; the policy reads sent_at only for sent, delivered, bounced and complained.
--
-- This file stays transactional and metadata-only: adding a nullable column with no default does
-- not rewrite the table, so it takes ACCESS EXCLUSIVE only for the instant the catalog changes.
-- The rows are filled afterwards by the background backfill (backfillSentAtOnce in
-- @agentic-marketing/db, started by the scheduler); until a row is filled the policy counts it from
-- updated_at exactly as 0.10.0 did. The index is built CONCURRENTLY in 0086, outside a transaction.
ALTER TABLE messages ADD COLUMN sent_at timestamptz;

COMMENT ON COLUMN messages.sent_at IS
  'When the provider accepted the message (#453), the start of every delivery cap window; null while queued, sending, suppressed or failed.';
