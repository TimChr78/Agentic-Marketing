-- Erased subjects (#1037, 0.17.0 part 1): the ClickHouse half of the durable erasure-key ledger.
--
-- Read-time exclusion (the next part of #1037) matches a stored row's subject keys against this
-- table before it is returned. Nothing prunes it: an erased identifier stays excluded permanently,
-- independently of the resolver's grace-window tombstones in PostgreSQL. Rows are published
-- idempotently from the committed erasure key ledger; republishing the same (workspace, kind, key)
-- leaves one row after merge.
--
-- `key` holds the same pseudonymous value the PostgreSQL ledger records: a profile, anonymous or
-- user id, or the workspace matching key's HMAC for an e-mail address or phone number. `key_version`
-- names the matching data key behind a hash (empty for ids), and `generation` lets a later read
-- reject exclusion state that is older than the erasure it claims to cover.
CREATE TABLE IF NOT EXISTS erased_subjects (
  workspace_id UUID,
  kind LowCardinality(String),
  key String,
  key_version String DEFAULT '',
  erasure_id String,
  generation UInt64,
  recorded_at DateTime64(3, 'UTC'),
  INDEX idx_key key TYPE bloom_filter GRANULARITY 4
) ENGINE = ReplacingMergeTree
PARTITION BY toYYYYMM(recorded_at)
ORDER BY (workspace_id, kind, key)
