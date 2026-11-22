---
section: Security
issues: [1194]
---
- `am restore` now reconciles the restored erasure ledger with ClickHouse's `erased_subjects`
  itself, as its last step after every ClickHouse load: missing exclusion keys are re-inserted in
  batches and confirmed visible — in chunks, so a workspace with tens of thousands of keys no
  longer exceeds ClickHouse's parameter size — before the restore reports success, and only then
  are the cleanup jobs marked published. This covers a Postgres-only restore, an older
  `--clickhouse` file, both, and a fresh target whose dump already carried a completed job, so an
  erased person is no longer readable after a restore, even before any scheduler runs.
- The restore interlock is now raised before Postgres is replaced, not after: `am restore` writes a
  fence row in `public.restore_fence`, a table no backup contains, so a `pg_restore` that commits
  changes and then fails still fails closed. A server refuses to start while the fence exists or
  while a restore holds the lock, and only a completed reconciliation (or the deliberate
  `am restore --clear-fence`) removes it.
- Every server process and `am migrate` now takes the restore lock **shared on a dedicated
  connection before running migrations** and holds it until shutdown, so a restore is refused even
  when a running app's pools are idle, and a starting process cannot migrate under a restore. The
  process exits if that connection is lost. `am restore` takes the same lock exclusively and
  `--clear-fence` takes it before touching the fence, so neither can run under the other.
- Reconciliation now runs per workspace with `app.workspace_id` set, so a restore run as a
  non-BYPASSRLS table owner (where FORCE RLS hides `erasure_keys`) reconciles the restored ledger
  instead of silently clearing the fence. A completed job is confirmed only after its outbox rows
  naming the erased profile are removed, including rows the snapshot left pending.
- The restore tests now write a real pre-erasure ClickHouse row for the erased identity in the
  Postgres-only and fresh-target shapes, and prove that shape fails (the row is readable) when the
  reconciliation is bypassed. The interlock has tests for a running server with idle pools, a
  start refused under the exclusive lock, `am migrate` taking the lock before its first migration,
  a lost lock connection, and `--clear-fence` refused under the lock.
- Completed jobs are published in bulk instead of being reopened for a fresh sweep, including a
  job the live log says was complete when the snapshot predates the job row; an unfinished job is
  queued for its remaining sweep. If a restore stops before reconciliation, it leaves the fence in
  place until a retry completes.
- `profiles.erasureStatus` reports `exclusion: 'unknown'` whenever an erasure has no ledger row at
  all, with `reason: 'legacy'` for a completed or absent job; a completed job with no ledger row
  stays `complete`, an unavailable ledger row still reports `partial`, and a pending legacy job
  keeps its own pending reason. It no longer uses the publication record to decide legacy status.
  The restore's end-of-run test suite also reads through the restored target's ledger and asserts
  the pre-erasure row is readable when reconciliation is bypassed, then excluded after it runs.
