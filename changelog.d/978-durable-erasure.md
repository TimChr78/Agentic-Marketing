---
section: Changed
issues: []
---
- **Breaking:** `profiles.erase` now returns `{ erasureId, counts: { profiles, identifiers, consentRecords }, status: "pending" }` instead of the flat counts. The person's profile, identifiers, consent ledger, messages, memberships and keys are gone when it returns; their ClickHouse events and the decision API's hot state are removed by a durable cleanup job. Read `profiles.erasureStatus` with the erasure id to see `pending`, `running`, `complete` or `failed`; erasures recorded before this release have no job and report `complete`.
- Erasure is one short SQL transaction with no network call, followed by a scheduler job that deletes from ClickHouse and hot state outside any transaction. The job checkpoints each store, retries a transient failure with backoff, and waits until no outbox row for the erased person is still undelivered, so an in-flight publisher cannot recreate their events after the cleanup. The selectors it needs are sealed with a per-erasure service key and purged when it completes.
- **The scheduler role performs the external cleanup.** A deployment without one deletes the SQL rows but leaves ClickHouse events and hot state until a scheduler runs; `am doctor` reports the backlog and failures as `queue.erasureCleanup`. A restore recreates the jobs for the erasures it replays.
- This is part 2b of 3 for #978 and does not close it.
