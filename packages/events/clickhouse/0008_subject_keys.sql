-- Subject keys on person-linked rows (#1037, 0.17.0 part 1).
--
-- Every stored row keeps, next to its existing columns, HMAC_exclusion(kind, value) for each
-- identifier it knows: the profile, anonymous and user ids it was written with, an alias
-- previousId, the workspace matching key's raw e-mail/phone traits (hashed with the exclusion key,
-- never the matching key), and the supported ad click ids from its context. The exclusion key
-- never reaches ClickHouse. Read-time exclusion (the next part of #1037) can then match any row
-- against `erased_subjects` without reading personal data and without changing today's reads.
--
-- `subject_keys_set` is 1 only when every applicable key was hashed. Older rows default to 0 and
-- are filled by the scheduler's backfill; a row that could not be keyed stays 0 and is retried, so
-- it is never mistaken for a complete row.
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_profile String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_anonymous String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_user String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_previous String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_email String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_phone String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_gclid String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_gbraid String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_wbraid String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_fbc String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_fbp String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_msclkid String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_li_fat_id String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_ttclid String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_ttp String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_epik String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_key_version String DEFAULT '';
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_keys_set UInt8 DEFAULT 0;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_subject_keys_set subject_keys_set TYPE set(2) GRANULARITY 4;

ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_profile String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_anonymous String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_user String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_previous String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_email String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_phone String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_gclid String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_gbraid String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_wbraid String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_fbc String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_fbp String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_msclkid String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_li_fat_id String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_ttclid String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_ttp String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_epik String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_key_version String DEFAULT '';
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_keys_set UInt8 DEFAULT 0;
ALTER TABLE message_events ADD INDEX IF NOT EXISTS idx_subject_keys_set subject_keys_set TYPE set(2) GRANULARITY 4;

ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_profile String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_anonymous String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_user String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_previous String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_email String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_phone String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_gclid String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_gbraid String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_wbraid String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_fbc String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_fbp String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_msclkid String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_li_fat_id String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_ttclid String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_ttp String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_epik String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_key_version String DEFAULT '';
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_keys_set UInt8 DEFAULT 0;
ALTER TABLE journey_events ADD INDEX IF NOT EXISTS idx_subject_keys_set subject_keys_set TYPE set(2) GRANULARITY 4;

-- The backfill's checkpoint, per table and workspace. `cursor` is the last processed primary-key
-- tuple as JSON (the tables are read per workspace, so a global cursor cannot skip another
-- tenant's rows). `final` means the next pass reads with FINAL, which is how a delayed legacy row
-- that sorts before the cursor is revisited. `done` is written only after a FINAL count of
-- `subject_keys_set = 0` rows for the workspace is zero. `revision` is the replacement version.
CREATE TABLE IF NOT EXISTS subject_key_backfill_cursors (
  table_name LowCardinality(String),
  workspace_id UUID,
  cursor String DEFAULT '',
  final UInt8 DEFAULT 0,
  done UInt8 DEFAULT 0,
  revision UInt64 DEFAULT 0,
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(revision)
ORDER BY (table_name, workspace_id)
