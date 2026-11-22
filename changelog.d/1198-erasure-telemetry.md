---
section: Fixed
issues: [1198]
---
- `profiles.erasureStatus` no longer claims `exclusion: full` for an erasure recorded before the durable ledger: with no ledger row and no successful publication record — including a retained cleanup job from an earlier release — nothing proves which identifiers were hashed, so it reports `exclusion: unknown` and `reason: legacy` while keeping `complete` for the SQL deletion that already happened. Its `complete` description now limits verified read exclusion to `exclusion: full`, or to the hashed identifiers when `partial`.
- The people page says the erasure was requested and cleanup continues in the background, instead of implying the person is already fully erased when `profiles.erase` returns.
- The recurring physical purge selects each batch of identities once, in a deterministic order, and deletes those literal tuples. A ClickHouse mutation can no longer re-evaluate a self-referencing `LIMIT` and delete a different or empty set of rows.
- The purge derives `deleted` from the rows of that fixed batch that are gone, so a concurrent insert no longer cancels out a real deletion and reports zero; `remaining` and `done` still come from a count taken after the synchronous delete.
- The purge deletes a `subject_key_backfill` side entry only while no base row that still depends on it exists (one whose coverage is not `full`), checked right before the delete and again inside its statement. A late legacy row that depends on the entry therefore cannot lose its only exclusion key and reopen the erasure.
- The purge worker renews and checks its workspace claim before every batch and table. The claim stops the next mutation after a takeover, but cannot stop a mutation already submitted to ClickHouse. A failed round now keeps its claim so the lease expires on its own instead of releasing it for an immediate retry.
