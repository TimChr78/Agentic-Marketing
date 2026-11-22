---
section: Security
issues: [1196]
---
- An erasure now fences a person's hot state in Valkey before deleting it: a per-subject tombstone outlives the longest hot-state TTL, and every snapshot write checks it in the same atomic operation, while a session write is fenced by every id on the event (anonymous, user and profile id). A session read is fenced by the user id beside the anonymous id, so a new anonymous id cannot rebuild the erased person's session. A tombstone write Valkey rejects fails the cleanup instead of letting it delete and checkpoint unfenced. The per-batch erasure-ledger lookup in ingest, and the fail-closed delete it performed when that lookup failed, are gone; ingest no longer touches Postgres on this path. The edge mirror queues only the ids it wrote, treats an erasure delete as terminal for its key, and re-checks the tombstone before a sync, so a refresh in flight cannot republish the snapshot to Workers KV. Edge propagation delay is otherwise unchanged.
