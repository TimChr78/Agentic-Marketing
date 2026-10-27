-- Campaign attribution needs to join raw conversion events to the person the message log names.
-- Ingest resolves the identifier to a profile once per batch; events that arrive before the
-- profile exists keep the empty string and are not attributed.
ALTER TABLE events ADD COLUMN IF NOT EXISTS profile_id String AFTER user_id;
ALTER TABLE events ADD INDEX IF NOT EXISTS idx_profile_id profile_id TYPE bloom_filter GRANULARITY 4;
