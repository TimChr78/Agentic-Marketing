-- Subject keys on person-linked rows (#1037, 0.17.0 part 1).
--
-- Every stored row keeps, next to its existing columns, the pseudonymous keys the erasure ledger
-- uses: the profile, anonymous and user ids it was written with, and the workspace matching key's
-- HMAC for an e-mail address or phone number where the writer had one. Read-time exclusion (the
-- next part of #1037) can then match any row against `erased_subjects` without reading PII, and
-- without changing today's read paths. Older rows default to empty and are filled by the
-- scheduler's batched backfill; `subject_keys_set` is the backfill's own checkpoint (1 once the row
-- has been processed, or written by the writer itself).
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_profile_id String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_anonymous_id String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_user_id String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_email_hash String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_phone_hash String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_key_version String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_keys_set UInt8 DEFAULT 0;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_subject_keys_set subject_keys_set TYPE set(2) GRANULARITY 4;

ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_profile_id String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_anonymous_id String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_user_id String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_email_hash String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_phone_hash String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_key_version String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_keys_set UInt8 DEFAULT 0;
ALTER TABLE message_events ADD INDEX IF NOT EXISTS idx_subject_keys_set subject_keys_set TYPE set(2) GRANULARITY 4;

ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_profile_id String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_anonymous_id String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_user_id String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_email_hash String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_phone_hash String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_key_version String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_keys_set UInt8 DEFAULT 0;
ALTER TABLE journey_events ADD INDEX IF NOT EXISTS idx_subject_keys_set subject_keys_set TYPE set(2) GRANULARITY 4;

-- The backfill's checkpoint. `subject_keys_set` on each row records that it was processed; this
-- cursor records which partition the scheduler finished, so a restart resumes after it instead of
-- replaying every partition. It holds no personal data and no workspace, so no row policy applies.
CREATE TABLE IF NOT EXISTS subject_key_backfill_cursors (
  table_name LowCardinality(String),
  cursor DateTime64(3, 'UTC'),
  revision UInt64 DEFAULT 0,
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(revision)
ORDER BY table_name

