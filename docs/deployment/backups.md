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
`postgresql-client-16`, matching the `postgres:16` service. Outside the image, install the
PostgreSQL 16 client tools; a missing `pg_dump` stops the backup with an error.

Backups contain subscriber addresses and consent records. The CLI sets umask `077` and creates the
backup directory (including the hidden `.partial` directory used during a run) with mode `0700` and
every file, including `manifest.json`, with `0600`, even when a bind-mounted host directory is
otherwise world-readable.
Keep the directory that way; do not loosen the modes to share a backup over a network.

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

1. Before replacing Postgres it reads every row of `erasures` and `erasure_tombstones` from the
   current database. If the log cannot be read, the restore stops rather than risk resurrecting
   someone.
2. After `pg_restore` it re-applies each erasure: profiles and identifiers the erasure names are
   deleted again (with their profile keys, consent records, messages, journey participations,
   segment memberships and push subscriptions), e-mail and phone suppression hashes are put back,
   and the erasure row and its keyed tombstones are re-inserted. Replay is idempotent, so restoring
   twice is safe, and entries for workspaces the snapshot no longer contains are skipped.
3. It then restores ClickHouse, if asked, and reports how many profiles and tombstones were replayed.

A person erased after the snapshot therefore stays erased: no profile, no identifiers, no profile
key, no consent, and the tombstones that stop late events from recreating them. Only keyed hashes
are replayed; no plaintext personal data is copied.

The replay covers Postgres. `am restore --clickhouse` inserts the event export as it was at snapshot
time, so event rows of a replayed person can still be present with their pseudonymous ids and
non-personal properties; the per-profile key that sealed their personal data is deleted again, so
that data stays unreadable. If the erasure procedure must also remove event rows, restore
ClickHouse from a backup taken after the erasure, or re-take the `--clickhouse` backup after applying
erasures. `am doctor`/`am smoke` and the erasure retention job keep operating on the restored data.


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
`CLICKHOUSE_DATABASE`; it does not read `AUTH_SECRET` or `MASTER_KEY`.

The scheduler writes `<BACKUP_DIR>/.schedule-status.json` (`0600`) at start and after every
minute tick: `{ lastRunAt, lastOk, lastError?, nextRunAt }`. Check it from a healthcheck with:

```bash
am backup --health
```

It exits 0 when the heartbeat is less than 2 minutes old and the last run did not fail; otherwise
it exits 1 and prints one line saying why. A Compose healthcheck can use:

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

- reports the snapshot time in its final line (`snapshot <createdAt>`);
- reads `erasures` and `erasure_tombstones` from the live database before touching it, and replays
  them after loading Postgres (see [Retention and erased people](#retention-and-erased-people));
- checks every file's size and SHA-256 before touching the database — and for `--clickhouse`, every
  ClickHouse file before the first `TRUNCATE`;
- refuses a manifest whose migration head is newer than this build knows, with a message to upgrade
  the image; `--force` overrides that check (use it only when you know the schema is compatible);
- **checks the key before replacing anything.** When the manifest has a `key.check`, `am restore`
  unwraps it with the configured provider. A wrong `MASTER_KEY` stops the restore before Postgres is
  touched, naming the key the backup needs and the `MASTER_KEY_PREVIOUS` option. A backup without a
  key check logs that it cannot be verified and continues.
- creates or updates the `am_app` role before loading, so the dump's `GRANT`s to it apply;
- runs `pg_restore --clean --if-exists --no-owner`, then unwraps a real data key from the restored
  database before reporting success (a second proof that provider, connector and profile secrets
  will be readable), then reports the restored version.

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
`pg_dump` is on `PATH` (CI installs PostgreSQL 16): it creates a database, inserts a marker, backs
it up, deletes the row, restores, and checks that the row comes back. It also checks the manifest
kind and versions, the `0700`/`0600` modes, `--list`, a newer migration head, a corrupted checksum,
that `--verify` passes on a good backup and fails on a tampered file, that a wrong `MASTER_KEY` is
refused before the database is touched, that `MASTER_KEY_PREVIOUS` restores an old backup, and that
a 0.2.4 format 1 backup with ClickHouse data is refused. When ClickHouse is reachable, a test
creates the real schema with row policies, writes events for two workspaces, and checks that the
backup has one non-empty file per workspace, that restore brings back each workspace's rows, and
that a query without `SQL_workspace` still sees none.
