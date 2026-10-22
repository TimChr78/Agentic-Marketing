-- Raw events (data-platform.md §5). At-least-once inserts: duplicates share event_id and collapse
-- on merge (ReplacingMergeTree); exact counts use FINAL or uniqExact(event_id).
-- PII-tagged properties are removed at ingest, so erasure only has to delete by identifiers.
CREATE TABLE IF NOT EXISTS events (
  workspace_id UUID,
  event_id String,
  source_id LowCardinality(String),
  received_at DateTime64(3, 'UTC'),
  timestamp DateTime64(3, 'UTC'),
  type LowCardinality(String),
  name LowCardinality(String),
  anonymous_id String,
  user_id String,
  properties JSON,
  traits JSON,
  context JSON,
  consent Map(LowCardinality(String), Bool),
  INDEX idx_anonymous_id anonymous_id TYPE bloom_filter GRANULARITY 4,
  INDEX idx_user_id user_id TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(received_at)
ORDER BY (workspace_id, name, anonymous_id, timestamp, event_id)
TTL toDateTime(received_at) + INTERVAL 25 MONTH
