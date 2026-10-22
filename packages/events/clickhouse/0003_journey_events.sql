-- What happened in journeys: entries, steps, waits, conversions, exits. Powers journey analytics
-- and per-node counts on the canvas. Deduplicated per (participant, seq, type).
CREATE TABLE IF NOT EXISTS journey_events (
  workspace_id UUID,
  journey_id String,
  version UInt32,
  participant_id UInt64,
  profile_id String,
  node String,
  type LowCardinality(String),
  seq UInt32,
  at DateTime64(3, 'UTC'),
  detail String
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(at)
ORDER BY (workspace_id, journey_id, participant_id, seq, type)
TTL toDateTime(at) + INTERVAL 25 MONTH
