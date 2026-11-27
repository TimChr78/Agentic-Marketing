# Backups and restore

`am backup` writes a portable directory with a Postgres dump, an optional ClickHouse export and a
`manifest.json`. `am restore` verifies it and replaces the live data. Both commands run without the
full server configuration, so they work while the app is stopped.

## What each store holds

| Store | Contents | Backed up? |
|---|---|---|
| Postgres | The source of truth: configuration, profiles and traits, consent, messages, journeys, templates, API keys, auth accounts. | Yes, always. |
| ClickHouse | Event history and analytics (events, message events, journey events, ad spend). Losing it loses historical stats; profiles and consent in Postgres are unaffected. | Only with `--clickhouse`. |
| NATS JetStream | Up to `NATS_RETENTION_HOURS` of in-flight events waiting for a worker. | No: it is a replayable buffer, not a source of truth. |
| Valkey | Session state, caches and hot-state mirrors. | No: ephemeral and rebuilt from Postgres/events. |
| `.env` | The secrets, including `MASTER_KEY`, which encrypts the provider and connector secrets stored in Postgres. | **No: keep a copy yourself**, apart from the backups (a password manager, say). A restored database is of little use without the `MASTER_KEY` it was encrypted with. |

Back up a consistent pair when you can: a Postgres-only restore brings profiles and consent back,
but the event history stays as it was at the restore point. Taking both in the same run keeps them
closer together.

## Taking a backup

```bash
# Inside the running app container; writes to the `backups` volume.
docker compose exec app am backup

# Also export every MergeTree table in ClickHouse.
docker compose exec app am backup --clickhouse

# A specific directory on the host (when the CLI runs outside Compose).
am backup --to ./backups
```

The name records the kind and the version the data was running:

| Kind | Name |
|---|---|
| manual | `am-manual-<build version>-<UTC stamp>` |
| scheduled | `am-scheduled-<build version>-<UTC stamp>` |
| automatic before upgrade | `am-pre-upgrade-<data version>-to-<new version>-<UTC stamp>` |

The UTC stamp looks like `20261027T031500Z`. `am-pre-upgrade` exists so the pair of versions is
obvious in a directory listing: the version the data last ran and the build that is about to migrate
it. When the migration head maps to a range (for example `0.2.3–0.2.4`), the name uses the newest
release (`0.2.4`) and the manifest's `fromVersion` keeps the range as
`0.2.3–0.2.4 (from migration head)`. Backups from 0.2.4 keep their older `am-<version>-<stamp>`
name; retention still recognises them.

The directory contains:

```text
am-manual-0.2.5-20261027T031500Z/
  manifest.json
  postgres.dump                    # pg_dump -Fc --no-owner
  clickhouse/                      # only with --clickhouse
    events/
      0f7c…-…-….native             # one file per workspace
      8a2d…-…-….native
    message_events/
      0f7c…-…-….native
    ad_spend/
      0f7c…-…-….native
    some_table_without_a_row_policy.native
```

The Postgres dump excludes `public.restore_fence`, the small table that records an unfinished
restore (see [After a failed or interrupted restore](#after-a-failed-or-interrupted-restore)). In a
dump written by 0.17.7 or later it is deliberately not part of the backup. A dump written by an
older build still carries the table — such a build can run against a database at this schema after a
rollback or a staggered upgrade — so `am restore` reads the archive's table of contents, removes
every entry that belongs to `public.restore_fence`, and loads with `pg_restore --use-list`. `--clean`
only drops the objects its list names, so the fence cannot be dropped or refilled at any point
during the load, even if the process dies before its next step. The load also raises this attempt's
fence row again afterwards, and the row it clears at the end is the one it raised. A backup is also
refused while the fence is raised, because
that database is not a valid restore point: finish the restore (`am restore`) or abandon it
deliberately (`am restore --clear-fence`) first. The scheduled service records the refused run as
failed, so `am backup --health` reports it. A backup also refuses to start while a restore is running,
and it holds the same restore lock **shared** for its whole capture (the fence read, the dump, the
ClickHouse export and the manifest write), so a restore cannot start between the fence check and the
dump or during the export; a restore that arrives meanwhile waits for the backup. That lock lives on
one dedicated session, so a transaction-pooling PgBouncer is not a suitable `DATABASE_URL` for a
backup either.

Tables whose `workspace_id` has a ClickHouse row policy (`events`, `message_events`,
`journey_events` and `ad_spend` by default) are exported once per workspace with `SQL_workspace`
set. A plain `SELECT` under that policy would return no rows, which is why 0.2.4 produced empty
files. Tables without the policy export as a single file. The export asks `system.row_policies`
which tables are filtered, so a custom policy is not missed.

`manifest.json` is format 2. It records the kind, the build that wrote it (`version`), the data
version (`fromVersion`), `toVersion` for a pre-upgrade backup, the highest applied
`schema_migrations` version, the creation time, the Postgres file, and for each ClickHouse table
its `totalRowsBefore` and a `files` list with `workspace`, `file`, `rows`, `bytes` and `sha256`.
`rows` is the number of rows ClickHouse actually returned (from `X-ClickHouse-Summary`), never the
table's estimated total.

It also records which key-encryption key the backup needs, and a sealed check value that proves a
configured key can unseal it:

```json
"key": {
  "reference": "local-3f2a9c1b7d4e",
  "check": { "kekId": "local-3f2a9c1b7d4e", "wrapped": "…base64 ciphertext…" }
}
```

`reference` is the provider's public id: `local-<sha256 prefix>` for a local `MASTER_KEY`,
`openbao:<mount>/<key>` for OpenBao Transit or `aws-kms:<key-id>` for AWS KMS. `check.wrapped` is a
fixed value sealed with that key; it is ciphertext, not a key or a data key. A backup container
started without `MASTER_KEY` (the Compose `backup` service does not need it) writes no `key` object,
and a restore of that backup logs that the key cannot be checked until the app starts. Take the
backup from a process with the key configured when you want the pre-restore check.

The data version is the newest `last_started_at` row in `server_versions`, written by the app at
startup. A database that last ran 0.2.4 or earlier has no such table yet; the backup then maps its
migration head to the release that shipped it (for example `0027_journey_consent_exits.sql` is
0.2.3–0.2.4). That is accurate enough to label an upgrade and is recorded in `fromVersion`.

If a table had rows before the export but none were written, the backup fails: an empty ClickHouse
file is data loss, not a valid backup. If the counts differ for a benign reason (events arriving
during the export, background merges of a ReplacingMergeTree, or rows belonging to workspaces that
no longer exist in Postgres), both numbers go into the manifest and the log warns; the backup still
succeeds.

Where it writes:

1. `BACKUP_DIR`, if set (Compose sets it to `/backups`);
2. otherwise `/backups` when that directory exists and is writable;
3. otherwise `./backups` under the directory the command was started from.

The `pg_dump`, `pg_restore` and ClickHouse HTTP calls stream to disk. The image includes
`postgresql-client-18`, which matches the `postgres:18` service and can also dump a 16 server for
the [PostgreSQL 18 upgrade](postgres-18.md). Outside the image, install the PostgreSQL 18 client
tools; a missing `pg_dump` stops the backup with an error.

Backups contain subscriber addresses and consent records. The CLI sets umask `077` and creates the
backup directory (including the hidden `.partial` directory used during a run) with mode `0700` and
every file, including `manifest.json` and `.verify-status.json`, with `0600`, even when a
bind-mounted host directory is otherwise world-readable. Keep the directory that way; do not loosen
the modes to share a backup over a network.

**The files are not encrypted.** `postgres.dump` and the ClickHouse Native files are plaintext once
`pg_restore` or ClickHouse can read them, and `manifest.json` has the key reference (never the key).
Protect the volume or host with encryption at rest (LUKS, ZFS encryption, an encrypted cloud disk or
an encrypted object-storage bucket), and keep `.env` with `MASTER_KEY` apart from the backups. An
encrypted volume protects a lost disk; it does not protect a backup copied to a share, so copy
backups only over an encrypted channel and to an encrypted destination. `am doctor` does not pretend
to detect volume encryption; this requirement is an operator responsibility.

`--keep-days N` (or `BACKUP_KEEP_DAYS`) deletes completed `am-*` directories older than N days
after a successful backup. It only removes directories that contain a `manifest.json`; partial
backups use a hidden temporary name until they are complete. Both the current names and the
0.2.4 `am-<version>-<stamp>` names match.

## Retention and erased people

`BACKUP_KEEP_DAYS` (the scheduler defaults to 14) is the maximum age of a snapshot that can still
be restored, and therefore the window in which a restored snapshot can predate an erasure. If you
copy backups to object storage, give the remote lifecycle the same or a shorter window; a copy that
outlives the local retention silently widens the window. Taking no backup for longer than the
retention period also widens it: the newest snapshot is then older than `BACKUP_KEEP_DAYS` suggests.

`am restore` closes the gap for erasures recorded in the live database:

1. Before replacing Postgres it reads every row of `erasures`, `erasure_tombstones`, the durable
   `erasure_keys` ledger, the wrapped exclusion `data_keys` and the per-workspace
   `erasure_generations` from the current database, together with any `erasure_cleanup_jobs`, and
   saves their union next to the backup directory in a mode-600 file bound to that database
   (PostgreSQL's `system_identifier` and database name) and that backup. If the log cannot be read,
   the restore stops rather than risk resurrecting someone. A retry merges the live log with that
   saved copy (replay is idempotent), so erasures recorded after a failed attempt are still
   replayed. The copy is removed only after a successful replay; a file bound to another database
   or backup, or a restore lock left by a crashed process, is refused by name so an operator can
   remove it deliberately. The captured file holds erasure records (`reason`, `requestedBy`, profile
   ids and counts), keyed tombstones, the sealed cleanup selectors with their wrapped service key,
   the ledger's pseudonymous ids and keyed hashes, and the wrapped exclusion keys — no plaintext
   identifiers. `reason` is operator text and may contain personal data, so do not copy the file
   off-host.
2. It applies pending migrations and then re-applies each erasure: profiles and identifiers the
   erasure names are deleted again (with their profile keys, consent records, messages, journey
   participations, segment memberships and push subscriptions), e-mail and phone suppression hashes
   are put back, and the erasure row, keyed tombstones, ledger rows and cleanup jobs are
   re-inserted. The wrapped exclusion keys the ledger references are restored and the one it uses is
   made active, so the stored hashes still match; the publication generation only moves forward.
   The migrations need `APP_DB_PASSWORD`, so a restore that has erasures to replay refuses to
   replace anything without it. Replay is idempotent, so restoring twice is safe, and entries for
   workspaces the snapshot no longer contains are skipped.
3. It then restores ClickHouse, if asked, and reports how many profiles, tombstones, erasure keys,
   exclusion keys and generations were replayed. Its last step runs after every ClickHouse load:
   it reconciles the **restored** `erasure_keys` ledger with `erased_subjects`, re-inserting the
   full-coverage keys the ClickHouse point is missing in batches and confirming they are visible
   before it reports success. Only then does it mark the corresponding cleanup jobs published. That
   covers every restore shape — a Postgres-only restore, an older `--clickhouse` file, both, and a
   fresh target — because it reads the ledger from the restored database rather than the live log (a
   fresh target has no live entries to replay). A job the snapshot already carried as complete is
   not reopened or swept again: the reconciliation publishes its keys in bulk, and the recurring
   physical purge handles restored rows. Before it confirms such a job complete it also removes the
   outbox rows its final worker pass would have removed — failed and delivered rows can still name
   the person (a confirmation token, a click URL), and because the restore holds the exclusive lock
   no dispatcher is running, so rows still pending are removed too rather than published after the
   start. That outbox pass also covers a completed job with no publishable key at all — an erasure
   recorded before the durable ledger, or one whose publication held no full-coverage key. A job
   that was still unfinished is queued for its remaining sweep. The restore also resets
   the workspace's `purged_generation` to `0`, so the scheduler's recurring physical purge sweeps
   the restored event rows again. If the restore stops before this reconciliation, it leaves a
   fence row in `public.restore_fence` and the app refuses to start until a restore completes, so a
   completed erasure is never readable again in between (#1194).

A person erased after the snapshot therefore stays erased: no profile, no identifiers, no profile
key, no consent, and the tombstones that stop late events from recreating them. Only keyed hashes
and wrapped keys are replayed; no plaintext personal data is copied.

The replay covers Postgres. `am restore --clickhouse` inserts the event export as it was at snapshot
time, so event rows of a replayed person can still be present with their pseudonymous ids and
non-personal properties; the per-profile key that sealed their personal data is deleted again, so
that data stays unreadable. Protected reads exclude the person once the restore has reconciled the
exclusion, which it does before it reports success, and the reset purge deletes the matching rows in
bounded batches. If the erasure procedure must remove event rows before that pass runs, restore
ClickHouse from a backup taken after the erasure, or re-take the `--clickhouse` backup after
applying erasures.
`am doctor`/`am smoke` and the erasure retention job keep operating on the restored data.


## Listing backups

```bash
am backup --list
am backup --list --dir /backups
```

Prints name, kind, data version, migration head, creation time, total size and the state of the
ClickHouse part, newest first. Format-1 backups (0.2.4) show kind `legacy` and ClickHouse
`empty (0.2.4, unusable)`, because their ClickHouse export is empty under row policies and
`am restore --clickhouse` refuses it. `--dir` defaults to the same `BACKUP_DIR` / `/backups` /
`./backups` rule as a backup. Only completed directories with a readable manifest are listed.

## Verifying a backup

```bash
# The newest backup under BACKUP_DIR (or /backups, or ./backups).
am backup --verify

# One backup set, or a directory that contains am-* backups.
am backup --verify /backups/am-manual-0.6.1-20261101T031500Z
am backup --verify --dir /backups
```

`--verify` does not touch a database. It:

1. reads `manifest.json` and re-hashes every file it names (Postgres and, when present, each
   ClickHouse Native file), checking sizes as well;
2. checks that the manifest's ClickHouse row counts are consistent, and refuses a table that had
   rows before the export but records none;
3. runs `pg_restore --list` on `postgres.dump`, which reads the custom-format archive's table of
   contents without restoring it. If `pg_restore` is not installed, this step is skipped with a
   warning; the hashes are still checked.

A corrupt or truncated file fails with the file name and the expected and actual SHA-256, and the
command exits 1. A successful run writes `<BACKUP_DIR>/.verify-status.json` (`0600`, `{ verifiedAt,
backup }`). You do not have to run it by hand after a scheduled backup: since 0.14.3 the scheduler
verifies each backup it writes (see [Scheduled backups](#scheduled-backups)). Run a real restore
drill (below) regularly anyway; a hash check cannot prove that the schema and data still restore
into a running app.

`am backup --health` reads that file: it exits 1 when no verification has ever run, or when the last
successful one is older than `BACKUP_VERIFY_MAX_AGE_DAYS` (default 30), in addition to the scheduler
heartbeat checks.

## Scheduled backups

The release bundle includes `compose.override.example.yaml` with a commented `backup` service.
Copy that service into `compose.override.yaml`, then start it:

```bash
docker compose up -d backup
docker compose logs -f backup
```

The service runs:

```text
am backup --schedule --clickhouse
```

It checks the cron expression every minute in UTC. `BACKUP_CRON` defaults to `30 3 * * *` and uses
the standard five fields (`minute hour day-of-month month day-of-week`), with `*`, numbers, lists
(`1,15`), ranges (`1-5`) and steps (`*/15`, `0-6/2`). `BACKUP_KEEP_DAYS` defaults to 14. A failed
run is logged and the next minute is still checked; `docker compose stop backup` (SIGTERM) stops
the loop after the current run. The container needs only `DATABASE_URL`, `CLICKHOUSE_URL` and
`CLICKHOUSE_DATABASE`; it does not read `AUTH_SECRET` or `MASTER_KEY`. Pass the same
`CLICKHOUSE_DATABASE` value the app uses (the `compose.override.example.yaml` block reads it from
`.env` with `${CLICKHOUSE_DATABASE:-am}`), or the dump targets the wrong database on an install that
renamed it. `DATABASE_URL` must be a `SUPERUSER` or have `BYPASSRLS`, also for a table owner: `pg_dump`
reads with `row_security = off`, and PostgreSQL refuses that on every `FORCE ROW LEVEL SECURITY`
table even for its owner. A backup therefore refuses a non-bypassing role before it starts the
dump, naming the role and the `ALTER ROLE … BYPASSRLS` fix. A dedicated backup role also needs
`SELECT` on `public.restore_fence`, which `am backup` reads before the dump to refuse an unfinished
restore; grant it with `GRANT SELECT ON public.restore_fence TO <role>`. A role that lacks the grant
is refused before the dump with a message naming that grant. (`am migrate` and `am restore` still
work as the table owner: they lift FORCE for the rows they read.)

The scheduler writes `<BACKUP_DIR>/.schedule-status.json` (`0600`) at start and after every
minute tick: `{ lastRunAt, lastOk, lastError?, nextRunAt }`. Check it from a healthcheck with:

```bash
am backup --health
```

It exits 0 when the heartbeat is less than 2 minutes old, the last run did not fail, and the last
successful verification is not older than `BACKUP_VERIFY_MAX_AGE_DAYS` (default 30); otherwise it
exits 1 and prints one line saying why. The scheduler verifies its own output: after every successful
scheduled backup it runs the same read-back check as `am backup --verify`, so a good run writes the
verification record that `--health` requires and no second container or host cron entry is needed.
A manual `am backup --verify` is still useful after a restore drill or for a backup directory the
scheduler did not write. A Compose healthcheck can use:

```yaml
healthcheck:
  test: ['CMD', 'am', 'backup', '--health']
  interval: 1m
  timeout: 10s
  retries: 3
```

Keep the `backups` volume out of the quick `docker compose down -v` path, and copy it off the host
regularly. A backup on the same disk as the database is not a disaster-recovery plan.

## Automatic backup before an upgrade

On start, before migrations run, the app checks whether the database has an applied migration head
and whether any migration files are still pending. If both are true it takes a Postgres-only backup
(it does not export ClickHouse) and logs the path. This happens only when migrations are about to
change the schema, not on every start.

The backup is named `am-pre-upgrade-<from>-to-<to>-<stamp>`, where `<from>` is the version the
database last ran (`server_versions`, or the migration-head map for a database older than 0.2.5)
and `<to>` is this build. It goes to `BACKUP_DIR`, `/backups` or `./backups` as above and obeys
`BACKUP_KEEP_DAYS`. Set `SKIP_PRE_UPGRADE_BACKUP=true` to turn it off, for example when an external
job already backs up Postgres. A missing `pg_dump`, an unwritable directory or a dump failure only
logs a warning: startup continues, because a development machine or a read-only container should
still boot. `SKIP_MIGRATIONS=true` also skips it, since this role is not running migrations at all.

## Restoring

Restoring replaces the database. Stop the app first so it cannot write while tables are dropped:

```bash
docker compose stop app
docker compose run --rm app am restore /backups/am-manual-0.2.5-20261027T031500Z --yes
docker compose start app
```

The one-off restore container mounts the same `backups` volume as `docker compose exec app am
backup`, so it sees those backups. Without `--yes`, an interactive terminal asks you to type
`restore`; a non-interactive run refuses. `--clickhouse` also truncates and reloads every ClickHouse
table in the manifest, inserting each workspace file. Start the app once against the target
ClickHouse before restoring with `--clickhouse`, so the tables exist; the restore replaces their
contents but does not create them.

`am restore`:

- takes one **exclusive** restore advisory lock for the whole run, so a second `am restore` — even of
  another backup directory — is refused with `another restore is running`, and so is every server
  start, `am migrate` and `am restore --clear-fence`. Every server process (every role) and
  `am migrate` take the same lock **shared** on a dedicated connection before their first migration
  and keep it until they shut down, so a restore is refused while any of them is running, even when
  its database pools are idle. The refusal says to stop every app, worker and scheduler first.
  `am backup` takes the lock shared too, for its whole capture, so a restore that arrives while a
  backup runs retries the exclusive lock for its drain bound, logs that it is waiting for the backup
  and, if the backup outlasts it, refuses with `a backup is still running`.
  Keeping the lock takes a dedicated database session, so a transaction-pooling PgBouncer is not a
  suitable `DATABASE_URL` for either side;
- refuses to run while an application process is still connected to the target database. That is
  the same shared lock; the `application_name` check remains as an extra diagnostic for a process
  from an older build (or one whose lock connection was lost before it exited). An open connection
  means a scheduler or worker could republish an erasure between the Postgres load and the
  ClickHouse load, which then replaces the published exclusions. Stop the app first, as above.
- waits for a previous restore's work before it writes. Right after taking the lock it polls for up
  to 60 seconds until no other backend on the target database announces `application_name =
  am-restore` or `am-backup` and no ClickHouse request carries the `am-restore-` query marker, then
  refuses with `a previous restore's work is still running` (or `a backup is still running` for
  `am-backup`) if any is still there. A backup's `pg_dump` announces `am-backup`, so a running
  backup no longer looks like a previous restore, and the restore waits for it rather than reading
  while the database changes under the dump. The advisory lock cannot
  fence work on other connections: the role setup, migration, erasure replay and reconciliation
  pools, the `pg_restore` child and ClickHouse `TRUNCATE`/`INSERT` requests all carry the marker.
  The ClickHouse load inserts synchronously (`async_insert=0`), so an insert stays visible until it
  has landed rather than flushing from the server's async buffer after the successor's `TRUNCATE`.
  A `DATABASE_URL` whose query string names another `application_name` does not change this: every
  connection a restore opens sets `am-restore` in the connection string, where the driver gives it
  precedence. The ClickHouse probe resolves the same endpoint the load and reconciliation use
  (`CLICKHOUSE_URL`, default `http://localhost:8123`) and runs in the target database, so a
  deployment that leaves the variable unset is still checked; if that endpoint cannot be reached
  within the drain's deadline the restore refuses rather than running unverified. With a URL that
  points at a load balancer or a multi-node cluster, `system.processes` shows only the node the
  endpoint resolves to, so a restore must use a pinned single-node URL (there is no cluster setting
  to widen the probe). A restore that loses its lock stops issuing new work and cancels in-flight
  ClickHouse requests. Residual limit: a run cut off by a network partition it has not yet noticed
  can still issue one request after the successor's check, so after a failed restore make sure the
  old `am restore` process has exited before retrying.
- reports the snapshot time in its final line (`snapshot <createdAt>`);
- reads `erasures` and `erasure_tombstones` from the live database before touching it, and replays
  them after loading Postgres (see [Retention and erased people](#retention-and-erased-people)).
  Every tenant table it reads is under `FORCE ROW LEVEL SECURITY`; run the restore as the table
  owner (the default for a small install) or as a role with `BYPASSRLS`. The owner lifts FORCE for
  one transaction and the lift is rolled back with it, so the log is read for every workspace. A
  role that is neither the owner nor able to bypass RLS is refused before Postgres is replaced,
  because it would see an empty log and replay nothing;
- checks every file's size and SHA-256 before touching the database — and for `--clickhouse`, every
  ClickHouse file before the first `TRUNCATE`;
- refuses a manifest whose migration head is newer than this build knows, with a message to upgrade
  the image; `--force` overrides that check (use it only when you know the schema is compatible);
- **checks the key before replacing anything.** When the manifest has a `key.check`, `am restore`
  unwraps it with the configured provider. A wrong `MASTER_KEY` stops the restore before Postgres is
  touched, naming the key the backup needs and the `MASTER_KEY_PREVIOUS` option. A backup without a
  key check logs that it cannot be verified and continues.
- creates or updates the `am_app` role before loading, so the dump's `GRANT`s to it apply;
- **raises the restore fence before replacing Postgres.** The row lives in `public.restore_fence`.
  Dumps written by 0.17.7 or later exclude the table, so it is not part of the backup. A dump from an
  older build can still name it, so the load removes every entry for the table from the archive's
  table of contents and restores with `pg_restore --use-list`: `--clean` then drops only the objects
  its list names, and the fence survives the whole load. The restore also raises the same row again
  right after the load, so an archive can neither drop it nor replace it. A server that finds the
  row refuses to start (`apps/server/src/main.ts`). It does
  that check while holding the shared restore lock, and it takes that lock **before** running
  Postgres or ClickHouse migrations, so a restore never overlaps a starting process. The process
  keeps the lock and its connection until shutdown (released after the workers drain and the pools
  close). That connection enables TCP keepalive and answers a lightweight liveness query every 30
  seconds, so a connection whose peer vanished without sending a close is noticed within a bounded
  time instead of never. If it drops, the server logs the reason and exits; a supervisor restarts
  it, which either re-acquires the lock or refuses on the fence. It is a dedicated connection, so it
  does not consume an app-pool slot;
- runs `pg_restore --clean --if-exists --no-owner`, then unwraps a real data key from the restored
  database before reporting success (a second proof that provider, connector and profile secrets
  will be readable);
- after the last ClickHouse load, reconciles the restored erasure ledger with `erased_subjects`
  (see [Retention and erased people](#retention-and-erased-people)) and does not report success
  until every key is visible; only then does it clear the fence. The final visibility read is
  batched, so a workspace with tens of thousands of keys does not exceed ClickHouse's parameter
  size;
- reports the restored version and clears the fence last.

`--skip-key-check` skips both key checks. Use it only when you know the secrets are not needed (for
example, restoring a database only to recover profiles and consent); the app will otherwise fail
when the first provider or connector secret is read.

Backups from 0.2.4 are format 1. Their ClickHouse export is empty whenever row policies are on
(the default), so `am restore --clickhouse` refuses that part with:

> This backup was made by 0.2.4, whose ClickHouse export is empty under row policies (#129);
> restoring it would delete your event history. Restore Postgres only (omit --clickhouse).

Restoring such a backup without `--clickhouse` is supported and safe. If you need the ClickHouse
data, take a fresh backup before upgrading, while you still have the 0.2.4 database; the truncate in
the restore is what turns an empty export into data loss.

The dump keeps table privileges even with `--no-owner` (that flag only skips ownership changes), so
the app role can read and write after the restore. At the same migration head the next app start
does not re-run applied migrations; the restored grants are what the app uses. When the backup is
from an older release, starting the app applies the missing migrations.

Postgres and ClickHouse are separate systems: the command restores Postgres first and ClickHouse
second. If the ClickHouse step fails (for example, a table was not created yet), the Postgres data
is already back; fix the table and run the same restore again.

### After a failed or interrupted restore

The fence is deliberately not cleared on failure: only a completed reconciliation (or an explicit
override) removes it. Keep every app, worker and scheduler stopped, fix the cause, and rerun the
same restore. The retry overwrites the fence, replaces Postgres again, replays the captured erasure
log, loads ClickHouse, reconciles the ledger and clears the fence only at the end. Replay is
idempotent, so this is safe even when the first attempt got as far as ClickHouse.

If the lock was lost, the retry first waits for the failed run's database and ClickHouse work to
stop (see above). Make sure the old `am restore` process has exited: a run cut off by a network
partition it has not yet noticed can still issue a request after that check.

If the restore must be abandoned, `am restore --clear-fence` removes the fence after a warning and
a typed confirmation (or `--yes` for a non-interactive run). It takes the same **exclusive** lock
as a restore first, so it refuses while a restore or any app, worker or scheduler still holds it,
and it waits for a previous restore's tagged work to stop before it writes, like a restore.
It does not reconcile anything: start the app only when you know `erased_subjects` holds the
exclusions the restored ledger needs, or you accept that reads may return someone whose erasure was
reported complete before the backup.

```
docker compose run --rm app am restore --clear-fence --yes
```

Restore is deliberately not a merge: rows written after the backup are gone. Erasures recorded in
the live database since the snapshot are the one exception, because they are replayed. Verify before
starting traffic, and keep a copy of the current volume until you are satisfied.

## Key rotation and old backups

`am rotate-keys` re-wraps the `data_keys` rows in the live database with the current provider. It
does **not** rewrite existing backups: a backup taken before the rotation still contains data keys
wrapped by the old key. Restoring that backup therefore needs the old key available to the restore
process.

For a local `MASTER_KEY` rotation:

1. Generate the new key. Set `MASTER_KEY=<new>` and `MASTER_KEY_PREVIOUS=<old>` in the environment.
2. Run `am rotate-keys`. New writes use the new key; the old key stays readable through
   `MASTER_KEY_PREVIOUS`.
3. Keep `MASTER_KEY_PREVIOUS=<old>` for at least the backup retention window (`BACKUP_KEEP_DAYS` or
   the remote lifecycle, whichever is longer), then remove it.

An old backup restored during that window logs `key check passed` and unwraps its data key through
the previous key. Without `MASTER_KEY_PREVIOUS`, the restore refuses before touching Postgres with:

> this backup needs the key local-…, but the configured key provider is local-… and cannot unseal it
> … Set MASTER_KEY … or add it to MASTER_KEY_PREVIOUS … `--skip-key-check` restores anyway …

Archive old keys with the backup set, never inside it: a password manager or secret store entry such
as "agentic-marketing master key 2026-10 (needed by backups before 0.7.1)". Do not put the key in
`manifest.json`, a filename, a log or the same encrypted volume as the backups, or losing that
volume loses both.

With OpenBao Transit or AWS KMS, keep the old key version or key id enabled for the same window: the
manifest's `reference` names the key (`openbao:<mount>/<key>`, `aws-kms:<key-id>`) and the provider
must still be able to decrypt with it. Disabling a KMS key or destroying a Transit version makes
every backup that used it permanently unreadable.

The same key is needed for the live database: `am doctor` reports `secrets.master-key-live` by
unwrapping a stored data key, so a key mismatch is visible before the next restore or send.

## Testing a restore

A backup is only useful if a restore works. A hash check (`am backup --verify`) catches corruption;
a drill catches a backup that hashes correctly but cannot run. Do a drill on a scratch host or
project:

1. Take a fresh backup: `docker compose exec app am backup --clickhouse`.
2. Verify it: `docker compose exec app am backup --verify`.
4. Copy the `am-*` directory somewhere safe.
5. In a throwaway Compose project with its own volumes, start the same image once (so ClickHouse
   tables are migrated), stop it, then restore:
   `docker compose stop app && docker compose run --rm app am restore /backups/am-… --yes --clickhouse`.
6. Start the app, sign in, open a profile and a segment, and check that recent events are present.
7. Run `docker compose exec app am doctor` (or `am smoke`) to check the install.

The integration test in `apps/server/test/backup.test.ts` does the Postgres part automatically when
`pg_dump` is on `PATH` (CI installs PostgreSQL 18): it creates a database, inserts a marker, backs
it up, deletes the row, restores, and checks that the row comes back. It also checks the manifest
kind and versions, the `0700`/`0600` modes, `--list`, a newer migration head, a corrupted checksum,
that `--verify` passes on a good backup and fails on a tampered file, that a wrong `MASTER_KEY` is
refused before the database is touched, that `MASTER_KEY_PREVIOUS` restores an old backup, and that
a 0.2.4 format 1 backup with ClickHouse data is refused. When ClickHouse is reachable, a test
creates the real schema with row policies, writes events for two workspaces, and checks that the
backup has one non-empty file per workspace, that restore brings back each workspace's rows, and
that a query without `SQL_workspace` still sees none.
