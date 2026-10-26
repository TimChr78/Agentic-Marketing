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

The directory name is `am-<version>-<UTC timestamp>` and contains:

```text
am-0.2.3-20261026T031500Z/
  manifest.json
  postgres.dump              # pg_dump -Fc --no-owner
  clickhouse/                # only with --clickhouse
    events.native
    message_events.native
    ...
```

`manifest.json` records the format version, the app version, the highest applied
`schema_migrations` version, the creation time, and each file's size and SHA-256. `am restore` uses
the migration head to refuse a backup from a newer release.

Where it writes:

1. `BACKUP_DIR`, if set (Compose sets it to `/backups`);
2. otherwise `/backups` when that directory exists and is writable;
3. otherwise `./backups` under the directory the command was started from.

The `pg_dump`, `pg_restore` and ClickHouse HTTP calls stream to disk. The image includes
`postgresql-client-16`, matching the `postgres:16` service. Outside the image, install the
PostgreSQL 16 client tools; a missing `pg_dump` stops the backup with an error.

`--keep-days N` (or `BACKUP_KEEP_DAYS`) deletes completed `am-*` directories older than N days
after a successful backup. It only removes directories that contain a `manifest.json`; partial
backups use a hidden temporary name until they are complete.

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

Keep the `backups` volume out of the quick `docker compose down -v` path, and copy it off the host
regularly. A backup on the same disk as the database is not a disaster-recovery plan.

## Automatic backup before an upgrade

On start, before migrations run, the app checks whether the database has an applied migration head
and whether any migration files are still pending. If both are true it takes a Postgres-only backup
(it does not export ClickHouse) and logs the path. This happens only when migrations are about to
change the schema, not on every start.

The backup goes to `BACKUP_DIR`, `/backups` or `./backups` as above and obeys `BACKUP_KEEP_DAYS`.
Set `SKIP_PRE_UPGRADE_BACKUP=true` to turn it off, for example when an external job already backs up
Postgres. A missing `pg_dump`, an unwritable directory or a dump failure only logs a warning:
startup continues, because a development machine or a read-only container should still boot.
`SKIP_MIGRATIONS=true` also skips it, since this role is not running migrations at all.

## Restoring

Restoring replaces the database. Stop the app first so it cannot write while tables are dropped:

```bash
docker compose stop app
docker compose run --rm app am restore /backups/am-0.2.3-20261026T031500Z --yes
docker compose start app
```

The one-off restore container mounts the same `backups` volume as `docker compose exec app am
backup`, so it sees those backups. Without `--yes`, an interactive terminal asks you to type
`restore`; a non-interactive run refuses. `--clickhouse` also truncates and reloads every ClickHouse
table in the manifest. Start the app once against the target ClickHouse before restoring with
`--clickhouse`, so the tables exist; the restore replaces their contents but does not create them.

`am restore`:

- checks every file's size and SHA-256 before touching the database;
- refuses a manifest whose migration head is newer than this build knows, with a message to upgrade
  the image; `--force` overrides that check (use it only when you know the schema is compatible);
- creates or updates the `am_app` role before loading, so the dump's `GRANT`s to it apply;
- runs `pg_restore --clean --if-exists --no-owner`, then reports the restored version.

The dump keeps table privileges even with `--no-owner` (that flag only skips ownership changes), so
the app role can read and write after the restore. At the same migration head the next app start
does not re-run applied migrations; the restored grants are what the app uses. When the backup is
from an older release, starting the app applies the missing migrations.

Postgres and ClickHouse are separate systems: the command restores Postgres first and ClickHouse
second. If the ClickHouse step fails (for example, a table was not created yet), the Postgres data
is already back; fix the table and run the same restore again.

Restore is deliberately not a merge: rows written after the backup are gone. Verify before
starting traffic, and keep a copy of the current volume until you are satisfied.

## Testing a restore

A backup is only useful if a restore works. Do a drill on a scratch host or project:

1. Take a fresh backup: `docker compose exec app am backup --clickhouse`.
2. Copy the `am-*` directory somewhere safe.
3. In a throwaway Compose project with its own volumes, start the same image once (so ClickHouse
   tables are migrated), stop it, then restore:
   `docker compose stop app && docker compose run --rm app am restore /backups/am-… --yes --clickhouse`.
4. Start the app, sign in, open a profile and a segment, and check that recent events are present.
5. Run `docker compose exec app am doctor` (or `am smoke`) to check the install.

The integration test in `apps/server/test/backup.test.ts` does the Postgres part automatically when
`pg_dump` is on `PATH` (CI installs PostgreSQL 16): it creates a database, inserts a marker, backs
it up, deletes the row, restores, and checks that the row comes back. It also checks that a newer
migration head and a corrupted checksum are refused. A separate test round-trips one ClickHouse
table when ClickHouse is reachable.
