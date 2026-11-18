-- Erased subjects (#1037, 0.17.0 part 1): the ClickHouse half of the durable erasure-key ledger.
--
-- Read-time exclusion (the next part of #1037) matches a stored row's subject keys against this
-- table before it is returned. Nothing prunes it: an erased identifier stays excluded permanently,
-- independently of the resolver's grace-window tombstones in PostgreSQL. Rows are published
-- idempotently from the committed ledger.
--
-- `generation` is a monotonic replacement version: a replay that re-publishes older state must
-- never overwrite a newer exclusion. There is no time partitioning — a replayed erasure may name
-- any month, and time is not part of the exclusion's identity. The ordering key is the full
-- replacement identity, so both key versions of a planned re-key stay addressable.
--
-- `key` holds HMAC_exclusion(kind, value) under the workspace exclusion key (never a raw id), and
-- `key_version` is that exclusion key's id.
CREATE TABLE IF NOT EXISTS erased_subjects (
  workspace_id UUID,
  kind LowCardinality(String),
  key String,
  key_version String,
  erasure_id String,
  generation UInt64,
  recorded_at DateTime64(3, 'UTC'),
  INDEX idx_key key TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplacingMergeTree(generation)
ORDER BY (workspace_id, kind, key, key_version)
