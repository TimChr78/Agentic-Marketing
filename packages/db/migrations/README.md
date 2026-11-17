# Migrations

Forward-only SQL, one file per schema change, applied in filename order — each in its own
transaction under an advisory lock. The runner records every file's checksum in
`schema_migrations`, so an applied file must never be edited: add a new one. The rules, including
the `-- am:no-transaction` marker for `CREATE INDEX CONCURRENTLY`, are in
[docs/development.md](../../../docs/development.md#migrations).

## Numbers

`NNNN_slug.sql`, four digits. Take the next free number (the highest one here plus one), never a
number that was skipped, and never renumber after review: the numbers are a history, not a count.
Parallel tasks on a phase take the numbers their plan reserved
([delegates](../../../docs/process/delegates.md)), which is how gaps appear.

**0040 and 0042 do not exist and must not be reused.** Both were reserved during Phase 16 (measure
and report, 0.2.9) for tasks running in parallel, and no migration was ever written under either
number. The file before the gap, `0039_journey_wait_until_entry_keys.sql`, came from Phase 15;
`0041` is the holdout groups (#67), `0043` the alerts (#76), and `0044` opened 0.2.10. No file with
either number appears anywhere in the repository history — that is checked, not assumed. The runner
sorts by name, so the sequence does not need to be contiguous. The later gaps (`0100`–`0102`,
`0105`) are the same kind of reservation and are equally not to be reused.

## Adding a migration

1. Add `NNNN_slug.sql` next to the others. Tenant tables carry `workspace_id` and row-level
   security; command handlers use the transaction they are given and do not filter by workspace.
2. Never edit a file that has shipped — the runner stops with "was changed after it was applied".
3. Keep long data changes out of the migration: they are a scheduler job that fills rows in short
   batches after start (the `messages.sent_at` backfill is the example).
4. In a `-- am:no-transaction` file every statement must survive a retry (`IF NOT EXISTS`,
   `ON CONFLICT DO NOTHING`, or an update that is harmless twice), because a failure leaves the
   earlier statements committed.
5. If the file becomes the new migration head of a release, add it to `MIGRATION_RELEASES` in
   [`packages/db/src/migrate.ts`](../src/migrate.ts) with that release; only heads are listed, and a
   release that shares a head with another is a range. `apps/server/test/version.test.ts` fails
   while the newest migration has no release.
6. A new table also goes into the owned-table lists in
   [`packages/db/test/sent-at-migration.test.ts`](../test/sent-at-migration.test.ts) and
   [`packages/db/test/suppressions-delete.test.ts`](../test/suppressions-delete.test.ts). Both
   migrate as the non-superuser `am_app` owner with `FORCE` row-level security, which is how a small
   install runs.
7. Run the migrations tests, not the whole suite:
   `npx vitest run --project packages packages/db/test/migrate.test.ts packages/db/test/sent-at-migration.test.ts packages/db/test/suppressions-delete.test.ts`.
