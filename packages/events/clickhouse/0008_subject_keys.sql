-- Subject keys on person-linked rows (#1037, 0.17.0 part 1).
--
-- Every stored row keeps, next to its existing columns, HMAC_exclusion(kind, value) for each
-- identifier its writer saw: the profile, anonymous and user ids, an alias previousId, the raw
-- e-mail/phone traits, and the supported ad click ids from its context. The exclusion key never
-- reaches ClickHouse. `subject_coverage` is the provenance of those hashes:
--   full     — the writer saw every applicable identifier (including a previousId/traits);
--   ids_only — only the ids a historical row still stores (set in the side table);
--   none     — no subject key was written.
-- A reader falls back to the side table only when the row's coverage is not `full`, so a writer's
-- complete row is never overridden by a backfill.
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
ALTER TABLE events ADD COLUMN IF NOT EXISTS subject_coverage LowCardinality(String) DEFAULT 'none';
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_subject_coverage subject_coverage TYPE set(3) GRANULARITY 4;

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
ALTER TABLE message_events ADD COLUMN IF NOT EXISTS subject_coverage LowCardinality(String) DEFAULT 'none';
ALTER TABLE message_events ADD INDEX IF NOT EXISTS idx_subject_coverage subject_coverage TYPE set(3) GRANULARITY 4;

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
ALTER TABLE journey_events ADD COLUMN IF NOT EXISTS subject_coverage LowCardinality(String) DEFAULT 'none';
ALTER TABLE journey_events ADD INDEX IF NOT EXISTS idx_subject_coverage subject_coverage TYPE set(3) GRANULARITY 4;

-- The backfill's results live here, keyed by each row's stable identity (events: event_id;
-- message_events: message_id, type, event_id; journey_events: journey_id, participant_id, seq,
-- type). A backfill never rewrites a person-linked row: a stale physical copy could otherwise
-- supersede a complete concurrent redelivery. Protected reads (PR 2) use
-- coalesce(row.subject_*, side.subject_*) when the row's coverage is not `full`.
CREATE TABLE IF NOT EXISTS subject_key_backfill (
  workspace_id UUID,
  table_name LowCardinality(String),
  key1 String,
  key2 String DEFAULT '',
  key3 String DEFAULT '',
  key4 String DEFAULT '',
  subject_profile String DEFAULT '',
  subject_anonymous String DEFAULT '',
  subject_user String DEFAULT '',
  subject_previous String DEFAULT '',
  subject_email String DEFAULT '',
  subject_phone String DEFAULT '',
  subject_gclid String DEFAULT '',
  subject_gbraid String DEFAULT '',
  subject_wbraid String DEFAULT '',
  subject_fbc String DEFAULT '',
  subject_fbp String DEFAULT '',
  subject_msclkid String DEFAULT '',
  subject_li_fat_id String DEFAULT '',
  subject_ttclid String DEFAULT '',
  subject_ttp String DEFAULT '',
  subject_epik String DEFAULT '',
  subject_key_version String DEFAULT '',
  -- ids_only (stored ids were hashable) or none (nothing to key, recorded so it is not retried).
  subject_coverage LowCardinality(String) DEFAULT 'none',
  -- Monotonic replacement version: a later result for the same identity wins.
  version UInt64,
  recorded_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(version)
ORDER BY (workspace_id, table_name, key1, key2, key3, key4);

-- Where the next batch starts, per table and workspace. The cursor is the last processed identity
-- tuple as JSON. It is reset at the end of a complete pass, because a low-frequency revalidation
-- must find legacy rows that landed behind an earlier cursor.
CREATE TABLE IF NOT EXISTS subject_key_backfill_cursors (
  table_name LowCardinality(String),
  workspace_id UUID,
  cursor String DEFAULT '',
  revision UInt64 DEFAULT 0,
  updated_at DateTime64(3, 'UTC') DEFAULT now64(3)
) ENGINE = ReplacingMergeTree(revision)
ORDER BY (table_name, workspace_id)
