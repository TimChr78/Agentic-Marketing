---
section: Fixed
issues: [1198]
---
- `profiles.erasureStatus` no longer claims `exclusion: full` for an erasure recorded before the durable ledger: with no cleanup job and no ledger row, nothing proves which identifiers were hashed, so it reports `exclusion: unknown` and `reason: legacy` while keeping `complete` for the SQL deletion that already happened.
- The recurring physical purge derives `deleted` and `remaining` from a count taken after each synchronous delete, so `done` and `deletedRows` are observed facts rather than estimates, and a write that lands mid-batch keeps the table open.
- The purge worker renews and checks its workspace lease before every batch and table, and stops the sweep if another replica took the claim, so two replicas cannot run overlapping mutations.
