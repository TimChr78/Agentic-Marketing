# PostgreSQL 18 and upgrading from 16

New installs run **PostgreSQL 18**. Existing installs on 16 keep working, but the release does
not upgrade a data directory in place: a data directory from one major version cannot be opened by
another, so the shipped Compose file stops before Postgres starts and tells you what to do. This
page is the upgrade path.

## Support window

| Version | New installs | Supported | Notes |
|---|---|---|---|
| 18 | default | yes | checksums on, async I/O, B-tree skip scan, `uuidv7()`, `pg_upgrade` keeps planner statistics |
| 16 | no longer the default | **yes, through at least June 2027** (all 0.x releases) | deprecated for new installs; upstream support runs to November 2028 |
| 15 and older | no | no | the migrations need `pg_auth_members` options that arrived in 16 |

`am doctor` prints the server version. A 16 server is reported as supported with a deprecation
note; anything below 16 is a warning, and you should upgrade before the next release. PostgreSQL 18
is recommended for every new install, including Kubernetes clusters and managed databases.

## What changed in the Compose file

- `postgres` now runs `postgres:18-alpine` by default, pinned by digest, and writes to the same
  `pgdata` volume at `/var/lib/postgresql/data`.
- `POSTGRES_IMAGE` in `.env` overrides that image. It must be an official Postgres image: the
  `postgres-check` service reads the volume's `PG_VERSION` and compares it with the image's major
  before Postgres starts. Use it to stay on 16 while you plan the move.
- `postgres-check` opens `pgdata` read-only. If the volume holds a different major it exits
  non-zero with this page's name, so `docker compose up -d` fails cleanly and the app never starts
  against an empty database. Nothing is deleted, and no fresh cluster is initialized in the
  volume while the old one sits beside it. When `up` reports a failed dependency, `docker compose
  logs postgres-check` prints the reason and the next step.

The app's `DATABASE_URL` is unchanged. The database name, role and password stay the same.

## Recommended: dump and restore into a fresh 18 volume

This uses the app's own tooling (`am backup` / `am restore`) and gives the new cluster its
default checksums. It needs free space for a dump (roughly the size of the database) and a short
write outage.

### 1. On the old release, take and verify a backup

Run this while the old stack is still serving. `am backup` writes to the `backups` volume, which
survives the next steps.

```bash
docker compose exec app am backup --clickhouse        # drop --clickhouse to leave events behind (they are not in Postgres)
docker compose exec app am backup --verify
docker compose exec app am backup --list              # note the am-manual-<version>-<stamp> name
```

Copy the directory off the backup volume as well, so a lost host does not take the only copy:

```bash
docker compose cp app:/backups/am-manual-<version>-<stamp> ./am-manual-<version>-<stamp>
```

`am backup --verify` re-hashes every file and reads the dump's table of contents; a backup that
fails this must not be used for the upgrade. If `am backup` is not in your release (before 0.2.4),
dump Postgres by hand: `docker compose exec -T postgres pg_dump -U am -Fc am > pre-upgrade.dump`.

### 2. Stop the stack and remove only the Postgres volume

```bash
docker compose down                                  # keeps every named volume, including backups
docker volume ls --filter name=pgdata                # e.g. agentic-marketing_pgdata
docker volume rm <project>_pgdata                    # the 16 data directory; the backup is the source of truth
```

The ClickHouse, NATS and `backups` volumes stay. Optional but cheap: keep a physical copy of the
old volume before removing it, for a rollback that does not need a restore:

```bash
docker run --rm -v <project>_pgdata:/from:ro -v "$PWD:/out" postgres:16-alpine \
  tar -C /from -czf /out/pgdata16.tar.gz .
```

### 3. Start the new release on a fresh 18 volume

Replace `docker-compose.yml` with the new release's copy (keep `.env` and `compose.override.yaml`),
make sure `.env` does not set `POSTGRES_IMAGE` (or set it to the 18 image), then:

```bash
docker compose up -d
docker compose exec app am doctor
```

This initializes an empty 18 cluster (checksums are on by default in 18) and the app migrates it.
The doctor check `postgres.version` shows the version, for example `PostgreSQL 18.7 is supported`.

### 4. Restore

Stop the app so nothing writes while the database is replaced, restore, then start it again:

```bash
docker compose stop app
docker compose run --rm app am restore /backups/am-manual-<version>-<stamp> --yes
# add --clickhouse when the backup contains the event history
docker compose up -d
```

`am restore` verifies the backup and the master key before it touches the database, creates the
app role, replays erasures recorded after the snapshot, and refuses a backup from a newer schema
than the image knows. It replaces the migrated empty database; that is expected.

### 5. Check

```bash
docker compose exec app am doctor
docker compose exec app am smoke --public-url https://links.example.com
```

Sign in, open a profile and a segment, and check that a recent event is present. Keep the backup
until you are satisfied.

## If the restore fails or you want to go back

The `backups` volume and the copy you copied off it are untouched by every step above.

1. Stop the new stack: `docker compose down`.
2. Get the previous release's files from its git tag (for example
   `https://raw.githubusercontent.com/TimChr78/Agentic-Marketing/v<previous>/docker-compose.yml`),
   keep the same `.env`, and remove the 18 `pgdata` volume with `docker volume rm <project>_pgdata`.
3. `docker compose up -d` with the previous version on a fresh 16 volume, then
   `docker compose stop app && docker compose run --rm app am restore /backups/<backup> --yes &&
   docker compose up -d`.

If you took the `pgdata16.tar.gz` copy, create an empty volume, extract the archive into it with the
same `docker run … tar -C /from -xzf /out/pgdata16.tar.gz` shape, and start the previous release
against it. A physical copy is not a substitute for the verified `am backup`, because it is only
readable by the same major version.

## Data checksums

PostgreSQL 18 enables **data checksums by default for a new cluster**; 16 leaves them off by
default. This is good for new installs — a checksum failure is reported instead of silently
returning corrupted pages — and it is why the dump-and-restore path above is the recommended one:
`initdb` in the 18 image creates checksummed pages, and `pg_restore` writes the data into them.

It matters if you choose `pg_upgrade` instead: `pg_upgrade` refuses a pair whose checksum settings
differ. Two ways to satisfy it:

- create the 18 cluster with `initdb --no-data-checksums`, upgrading the old setting as-is, then
  enable checksums later with `pg_checksums --enable` while the 18 cluster is stopped (this
  rewrites every page and needs free space); or
- enable checksums on the 16 cluster first (`pg_checksums --enable`, cluster stopped) and then
  upgrade into a default 18 cluster. Enabling checksums on 16 is itself an offline, page-rewriting
  operation, so most installs should use dump and restore.

Check a running server with `SHOW data_checksums;` (`on`/`off`).

## Advanced: `pg_upgrade`

`pg_upgrade` is faster on a large database (it copies or links the files) and, in 18, carries the
planner statistics over, so queries do not stall waiting for `ANALYZE`. It is also less forgiving:
both server majors must be installed, the clusters need the same locale and encoding, the checksum
settings must match, and it must run with all writers stopped.

The official `postgres:18` image only contains 18's binaries and data layout. Run `pg_upgrade`
from a temporary container that has **both** majors (for example a Debian image with the PGDG
`postgresql-16` and `postgresql-18` packages, or a build that copies `/usr/lib/postgresql/16` from
the 16 image into the 18 image). Sketch:

```bash
docker compose down                     # all writers stopped
# mount the old 16 volume at /old and a new empty volume at /new, then as the postgres user:
initdb -D /new --no-data-checksums      # match the 16 cluster (see above); or enable 16's checksums first
pg_upgrade --old-bindir /usr/lib/postgresql/16/bin --new-bindir /usr/lib/postgresql/18/bin \
  --old-datadir /old --new-datadir /new --copy
```

No `ANALYZE` pass is needed afterwards: 18 carries the planner statistics over. Start PostgreSQL 18
against `/new` by pointing `PGDATA` (or the volume layout) at it, then run `am migrate` (or start
the app) and `am doctor`. No schema dump is involved: the migrations are already in the upgraded
database. Keep the old volume until the new install is verified; a `pg_upgrade` cannot be undone by
starting the old server on the new files.

## Kubernetes (Helm)

The chart does not run Postgres; point `DATABASE_URL` at a managed service or an operator such as
CloudNativePG. For a new cluster use PostgreSQL 18. For an existing 16 cluster, the upgrade is the
same decision as Compose, done with the operator's tooling:

1. Stop all writers: scale `api`, `ingest`, `worker` and `scheduler` to zero (`helm upgrade` with
   `roles.*.replicas=0`, or `kubectl scale`).
2. Use CloudNativePG's major-version upgrade (`pg_upgrade` under the hood) or a dump/restore job.
   The application image has `pg_dump`/`pg_restore` 18 and can dump a 16 server, so a Kubernetes
   `Job` running `am backup` against the old database and `am restore` into the new one works too.
3. Point the `DATABASE_URL` secret at the new 18 service, then run the chart's migration hook
   (`helm upgrade` with the new values). The hook runs `cli migrate` before the roles roll.
4. Scale the roles back up and run `am doctor` in an `api` pod; `postgres.version` must report 18.
5. Rollback: the old cluster and the dump remain; point `DATABASE_URL` back and scale up the
   previous release's roles. The schema is forward-only, so restore the pre-upgrade backup if the
   new version already migrated the old cluster.

`POSTGRES_IMAGE` and `postgres-check` are Compose-only. On Kubernetes the guard is the operator's
major-version upgrade, and `am doctor`'s version check catches a `DATABASE_URL` that still points
at 16 after the move.

## Why the app stays compatible with both

The migrations use features that exist in 16 (the app role checks read `pg_auth_members` options
that arrived in 16), and nothing depends on an 18-only default. `am backup`/`am restore` use
`pg_dump`/`pg_restore` from the image, which are version 18: a newer `pg_dump` can read an older
server, so the same image backs up a 16 install before the move and a 18 install afterwards.

One cosmetic difference is handled: `pg_dump` 18 writes `SET transaction_timeout = 0` (a 17+
setting) into every archive, and a 16 server rejects that one statement. `pg_restore` ignores it
and restores the rest, so `am restore` accepts that exact single error on a 16 target and warns;
any other error still fails the restore. That makes the rollback above work with the new image as
well as the previous one.
