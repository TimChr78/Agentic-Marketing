---
section: Security
issues: [1196]
---
- An erasure is now the final word on the decision API's hot state: a snapshot refresh or a late accepted event that was already in flight can no longer recreate a snapshot or session for an erased person, so `/v1/decide` does not personalise from it. Sessions are checked against the durable erasure ledger and snapshots against the profile rows after the write; edge Workers KV propagation is unchanged.
