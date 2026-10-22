-- What happened to each message (data-platform.md §5): the gateway's decision (sent, suppressed,
-- failed) and the provider's delivery events (delivered, bounced, complained, opened, clicked,
-- unsubscribed). No addresses, only our ids. Deduplicated on (message, type, event id).
CREATE TABLE IF NOT EXISTS message_events (
  workspace_id UUID,
  message_id String,
  event_id String,
  type LowCardinality(String),
  at DateTime64(3, 'UTC'),
  profile_id String,
  channel LowCardinality(String),
  purpose LowCardinality(String),
  provider LowCardinality(String),
  template_id String,
  template_version UInt32,
  journey_id String,
  reason String,
  url String,
  INDEX idx_profile profile_id TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(at)
ORDER BY (workspace_id, message_id, type, event_id)
TTL toDateTime(at) + INTERVAL 25 MONTH
