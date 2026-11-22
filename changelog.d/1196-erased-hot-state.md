---
section: Security
issues: [1196]
---
- An erasure now fences a person's hot state in Valkey before deleting it: a per-subject tombstone outlives the longest hot-state TTL, and every snapshot and session write checks it in the same atomic operation, so a scheduled refresh or a late accepted event can no longer recreate state that `/v1/decide` would personalise from. The per-batch erasure-ledger lookup in ingest, and the fail-closed delete it performed when that lookup failed, are gone; ingest no longer touches Postgres on this path. Edge Workers KV propagation is unchanged.
