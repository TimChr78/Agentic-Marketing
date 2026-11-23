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
- Each per-workspace reconciliation query now names its workspace explicitly. A restore commonly
  runs as a superuser or a role with `BYPASSRLS`, which does not isolate tenants by itself; without
  the predicate every workspace's keys were published into whichever workspace was being handled.
- The live erasure log is read for every workspace when the restore runs as the table owner under
  FORCE RLS: the owner lifts FORCE for one transaction and the lift rolls back with it, so the
  erasures and keys recorded since the snapshot are replayed instead of reading as empty. The
  replay reads the restored workspace list the same way, so an owner no longer skips every entry
  as if its workspace had disappeared. A role that can see neither the whole log nor all
  workspaces refuses the restore before Postgres is replaced, rather than replaying nothing.
- A completed cleanup job with no publishable key at all — an erasure recorded before the durable
  ledger, or one whose publication held no full-coverage key — still gets its final outbox pass
  after a restore, so a restored pending row naming the erased person is not delivered by the app
  that starts next.
- Losing the restore lock now stops the children the restore started (`pg_dump`, `pg_restore`)
  before it fails: SIGTERM, then SIGKILL, instead of leaving a child writing into a database that
  another restore may already own. The handler waits until every child is actually gone before the
  process exits, so a `pg_restore` that ignores SIGTERM cannot outlive the interlock, and the restore
  itself aborts between steps and before every write instead of finishing. The fence is written and
  cleared through the session that holds the exclusive lock and only when the row is this attempt's,
  so a restore that lost its lock can no longer delete the fence a newer attempt raised.
- A restored snapshot from before the durable erasure ledger (no `erasure_keys`) still gets the
  completed jobs' final outbox pass: only the ClickHouse publication is gated on the ledger, so a
  pending outbox row naming an erased profile is removed from the restored database.
- The restore tests now write a real pre-erasure ClickHouse row for the erased identity in the
  Postgres-only and fresh-target shapes, and prove that shape fails (the row is readable) when the
  reconciliation is bypassed. The interlock has tests for a running server with idle pools, a
  start refused under the exclusive lock, `am migrate` taking the lock before its first migration,
  a lost lock connection, and `--clear-fence` refused under the lock.
- A lost restore lock no longer lets a second restore race the first one's work. Every PostgreSQL
  connection a restore opens announces `application_name = am-restore` (`PGAPPNAME` for the
  `pg_restore`/`pg_dump` children), and every ClickHouse request it issues carries an
  `am-restore-` `query_id`. Right after taking the exclusive lock — before any write — a restore
  (and `am restore --clear-fence`) polls for up to 60 seconds until no other backend on the target
  database and no ClickHouse request with that marker is running, then refuses with
  `a previous restore's work is still running` instead of racing it.
- A restore that notices its lock was lost now also stops issuing ClickHouse work: the abort signal
  reaches the ClickHouse load (TRUNCATE and every INSERT, with in-flight requests cancelled),
  in-flight exclusion publications, and the reconciliation's generation-allocation, outbox and
  purge-reset writes. Residual limit: a run cut off by a network partition it has not yet noticed
  can still issue one request after a successor's drain check, so an operator retrying after a
  lock-loss failure should make sure the old `am restore` process has exited.
- New restore tests cover a successor waiting on a tagged `am-restore` backend and on a running
  ClickHouse query with the marker (refusing after a short bound in both cases), a ClickHouse load
  that sends nothing after its signal aborts, and `pg_restore` running with `PGAPPNAME=am-restore`.
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
- The drain now finds a predecessor's ClickHouse work by the database each running query uses
  (`current_database`), not by the probe's own database, and it probes the endpoint the ClickHouse
  load resolves — `CLICKHOUSE_URL`, or `http://localhost:8123` when it is unset — so a Postgres-only
  restore is checked against the same ClickHouse point a later load would replace. Both halves of
  the probe end at the drain's deadline instead of waiting on a stalled server, and a URL that
  points at a load balancer or a multi-node cluster covers only the node it resolves to: pin one
  node's URL for a restore.
- Every PostgreSQL connection a restore opens announces `am-restore` in the connection string, so a
  `DATABASE_URL` that carries its own `?application_name=` (a pooler's name, say) can no longer hide
  the restore's backends from a successor's drain.
- A restore that notices its lock is gone now checks the abort signal before migrating, before
  opening the replay connection and before every replay statement, and before each ClickHouse
  visibility chunk, so no write or request follows the lock loss even when the signal already fired.
- The restore's ClickHouse load now inserts synchronously (`async_insert=0`), so an insert stays visible
  to a successor's drain until it has landed instead of flushing from the async buffer after the
  successor's `TRUNCATE`.
