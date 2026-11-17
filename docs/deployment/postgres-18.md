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

## Recommended: drain, take a final backup, restore into a new 18 volume

This uses the app's own tooling (`am backup` / `am restore`) and gives the new cluster its default
checksums. It needs free space for a dump (roughly the size of the database) and a write outage
from the start of the backup until the checks pass. The old 16 volume is **retained**, not
deleted, so a rollback is a version switch rather than a restore.

> Do the first three steps with the **current release's files still in place**. In particular, do
> not copy the new `docker-compose.yml` over the old one before the final backup: the new file
> starts PostgreSQL 18, and the `postgres-check` guard would stop on the old 16 volume. Replace the
> file in step 4, after the backup and the optional volume copy.

> **Why the drain comes first.** A backup taken while people are using the install is a snapshot
> from before the writes that arrive while it runs. Those writes would be lost, and an erasure
> processed after the snapshot would be undone: the restore brings the erased profile back.
> Stopping every writer before the final backup makes the snapshot the last state, and keeping
> traffic stopped through the restore and the checks means nothing has to be replayed afterwards.

### 1. Stop every writer

Compose runs all roles in one `app` container; stop it (and every other app/role container if you
split them):

```bash
docker compose stop app
```

Helm: scale `api`, `ingest`, `worker` and `scheduler` to zero (`helm upgrade` with
`roles.*.replicas=0`, or `kubectl scale`). Postgres, ClickHouse, NATS and Valkey can stay up; only
the processes that write to them must stop.

### 2. Take and verify the final backup with the current (0.15.x) image

Do not change `AM_VERSION` yet: this step must run the **old** image. Its `pg_dump` is 16, so the
archive has no 17+ settings and restores cleanly into either a 16 or an 18 server. (The 0.16
image's `pg_dump` is 18 and can also read a 16 server, but keeping the old image here makes the
rollback path below use matching tools.)

`am backup` writes to the `backups` volume, which survives the volume switch:

```bash
docker compose run --rm app am backup              # add --clickhouse to include event history
docker compose run --rm app am backup --verify
docker compose run --rm app am backup --list       # note the am-manual-<version>-<stamp> name
```

Copy the directory off the backup volume as well, so a lost host does not take the only copy
(`docker cp` works on the stopped `app` container):

```bash
docker compose cp app:/backups/am-manual-<version>-<stamp> ./am-manual-<version>-<stamp>
```

`am backup --verify` re-hashes every file and reads the dump's table of contents; a backup that
fails this must not be used for the upgrade. If `am backup` is not in your release (before 0.2.4),
dump Postgres by hand with the old image: `docker compose exec -T postgres pg_dump -U am -Fc am >
pre-upgrade.dump`.

Keep `app` stopped through step 5; it starts only at the final cutover in step 6.

### 3. Optionally copy the 16 volume (after stopping PostgreSQL)

The verified logical backup is the real rollback; this filesystem copy is a second, faster path.
PostgreSQL must be **shut down** for a filesystem-level copy — a tar of a running cluster's files
can be inconsistent. Stop it after the logical backup, then copy:

```bash
docker compose stop postgres
docker run --rm -v <project>_pgdata:/from:ro -v "$PWD:/out" postgres:16-alpine \
  tar -C /from -czf /out/pgdata16.tar.gz .
```

Leave Postgres stopped. Do **not** delete `pgdata` at any point in this procedure. The new stack
gets its own volume.

### 4. Replace the release files and start only PostgreSQL 18

Now replace `docker-compose.yml` with the new release's copy; keep `.env` and
`compose.override.yaml`. Docker cannot rename a volume, so give the new stack a second volume.
Add this block to `compose.override.yaml` (or keep it in a separate file and pass it with `-f`).
No `!override` is needed: Compose merges `volumes` by container path, so an entry with the same
target (`/var/lib/postgresql/data`) replaces the shipped one.

```yaml
services:
  postgres-check:
    volumes:
      - pgdata18:/var/lib/postgresql/data:ro
  postgres:
    volumes:
      - pgdata18:/var/lib/postgresql/data
volumes:
  pgdata18:
```

Now set the **new release** explicitly and make sure the 18 image is used:

```bash
# in .env:
#   AM_VERSION=0.16.0
#   POSTGRES_IMAGE unset (the 18 default) or the postgres:18 image
docker compose pull
docker compose up -d postgres
```

Only `postgres-check` and `postgres` start, and the app stays down. Do **not** use a bare
`docker compose up -d` here: it would start the app's workers against the empty 18 database. The
old ClickHouse, NATS and Valkey containers are still running from the previous stack; if you
stopped them too, start them without the app:
`docker compose up -d clickhouse nats valkey`.

The guard checks the empty `pgdata18` and 18 initialises there; the old `pgdata` is not mounted at
all, so nothing can write to it.

### 5. Restore, with every writer still stopped

`app` was never started in step 4. If it is running for any reason, stop it first. Run the restore
as a one-off container with `--no-deps`, so it does not start the app or its dependencies:

```bash
docker compose stop app
docker compose run --rm --no-deps app am restore /backups/am-manual-<version>-<stamp> --yes
# add --clickhouse when the backup contains the event history
```

`--no-deps` matters: `am restore` is a CLI operation, not the server, so this one-off never starts
a worker. No process consumes NATS events or writes ClickHouse while the database is replaced.
`am restore` verifies the backup and the master key before it touches the database, creates the app
role, and refuses a backup from a newer schema than the image knows. It replaces the migrated empty
18 database; that is expected. Because the backup was taken after the writers stopped, there is no
erasure or write recorded after it to replay or lose.

### 6. Verify read-only, then cut over once

Keep the app and public traffic stopped. These checks read the restored database without starting
the server (they need Postgres, ClickHouse, NATS and Valkey, which are up):

```bash
docker compose run --rm --no-deps app am doctor
docker compose exec postgres psql -U am -d am -c 'select count(*) from schema_migrations'
```

`am doctor` should report `PostgreSQL 18.7 is supported`, schema up to date and no failures; add a
few row counts for the things you care about (profiles, messages, a recent event). This is the last
point at which rollback to the retained 16 volume is lossless.

When the checks pass, do the single cutover, which starts the writers and the public listener:

```bash
docker compose up -d
docker compose exec app am smoke --public-url https://links.example.com
```

Sign in, open a profile and a segment, and check that a recent event is present. Keep the old
`pgdata` volume, `pgdata16.tar.gz` and the backup until you are satisfied.

After the cutover and these checks, remove only the old 16 volume; the override keeps the install
on `pgdata18`:

```bash
docker volume rm <project>_pgdata
```

Keep the `pgdata18` block in `compose.override.yaml` as the volume name for this install. It is
part of the deployment from now on; there is nothing to rename.

## If the restore fails or you want to go back

### Before the final cutover (lossless)

The old data is still in `pgdata`, untouched, and no writer has used the 18 database yet. This is
the only lossless rollback point.

1. `docker compose down`.
2. In `.env`, set `AM_VERSION` to the **previous release** and
   `POSTGRES_IMAGE=postgres:16-alpine@sha256:<previous digest>` (copy it from the previous
   release's `docker-compose.yml` or its `.env.example`). Remove the `pgdata18` block from
   `compose.override.yaml`, so the stack mounts `pgdata` again.
3. `docker compose up -d`. The guard accepts the 16 image on the 16 volume and the old version
   starts with its data. No restore is needed.

**Do not point a 0.15.x image at the 18 database.** Its client tools are 16 and cannot dump an 18
server; rolling back means the retained 16 volume, not the 18 one.

**After the cutover in step 6, the retained 16 volume is no longer current.** Every write and
erasure accepted by 18 after that point exists only in `pgdata18`; starting the old version on
`pgdata` then loses them. Use the path below only when you accept that, and restore from the
backup (or the physical copy) rather than expecting the 16 volume to have the latest data.

### After the cutover, or after the 16 volume is removed

Start the previous release on a fresh 16 volume (`AM_VERSION=<previous>`,
`POSTGRES_IMAGE=postgres:16-alpine@sha256:<previous digest>`, no `pgdata18` override) and restore
the verified pre-upgrade backup. That backup was made by the 0.15.x image with its 16 client, so
it restores into 16 with the matching tools. If you took `pgdata16.tar.gz`, create an empty volume,
extract the archive into it, and start the previous release against it instead.

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
settings must match, and it must run with all writers stopped — the same drain as step 1. Take the
final backup from step 2 before upgrading as well; `pg_upgrade` is not a substitute for a
restorable copy.

The official `postgres:18` image only contains 18's binaries and data layout. Run `pg_upgrade`
from a temporary container that has **both** majors (for example a Debian image with the PGDG
`postgresql-16` and `postgresql-18` packages, or a build that copies `/usr/lib/postgresql/16` from
the 16 image into the 18 image). Sketch:

```bash
docker compose down                     # all writers stopped; keep the volumes
# mount the old 16 volume at /old and a new empty volume at /new, then as the postgres user:
initdb -D /new --no-data-checksums      # match the 16 cluster (see above); or enable 16's checksums first
pg_upgrade --old-bindir /usr/lib/postgresql/16/bin --new-bindir /usr/lib/postgresql/18/bin \
  --old-datadir /old --new-datadir /new --copy
```

No `ANALYZE` pass is needed afterwards: 18 carries the planner statistics over. Start PostgreSQL 18
against `/new` by pointing `PGDATA` (or the volume layout) at it, then run `am migrate` and
`am doctor` as one-off CLI commands while the app stays down. Verify, then cut over once. No schema
dump is involved: the migrations are already in the upgraded database. Keep the old volume until the
new install is verified; a `pg_upgrade` cannot be undone by starting the old server on the new files.

## Kubernetes (Helm)

The chart does not run Postgres; point `DATABASE_URL` at a managed service or an operator such as
CloudNativePG. For a new cluster use PostgreSQL 18. For an existing 16 cluster, the upgrade is the
same decision as Compose, done with the operator's tooling:

1. Stop all writers: scale `api`, `ingest`, `worker` and `scheduler` to zero (`helm upgrade` with
   `roles.*.replicas=0`, or `kubectl scale`), and keep them at zero through the restore and checks.
2. Take the final backup with the current release's image after the drain, exactly as in step 2;
   the app's `am backup` and `am restore` work with the chart's `DATABASE_URL` and `BACKUP_DIR`.
3. Use CloudNativePG's major-version upgrade (`pg_upgrade` under the hood) or a dump/restore job.
   The application image has `pg_dump`/`pg_restore` 18 and can dump a 16 server, so a Kubernetes
   `Job` running `am backup` against the old database and `am restore` into the new one works too.
   Keep the old cluster until the new one is verified.
4. Set `image.tag` (and the chart's `appVersion` when installing a bundle) to **0.16.0**, point the
   `DATABASE_URL` secret at the new 18 service, then run the chart's migration hook
   (`helm upgrade`) **with the roles still at zero**. The hook migrates the empty 18 database
   before any role exists; no worker starts, so nothing consumes NATS or writes ClickHouse.
5. Restore with a one-off pod or Job from the 0.16 image (`am restore <backup> --yes`, no server
   process), then verify read-only with a one-off `am doctor` pod while the roles stay at zero.
   `postgres.version` must report 18 and there must be no failures. This is the last lossless
   rollback point.
6. Final cutover: scale the roles back up (`helm upgrade` with the normal replica counts), then run
   `am smoke` against the public URL. This is the first point writers accept traffic on 18.
7. Rollback: **before** the cutover, point `DATABASE_URL` back at the old cluster, set the image tag
   to the previous release, and scale the roles up. After the cutover, the old cluster no longer
   has the writes and erasures accepted by 18; restore the pre-upgrade backup into a fresh 16
   cluster and use the previous image, accepting the loss of post-cutover data. A 0.15.x pod cannot
   read an 18 database (its client tools are 16), so do not roll back by pointing the old image at
   the new cluster.

`POSTGRES_IMAGE` and `postgres-check` are Compose-only. On Kubernetes the guard is the operator's
major-version upgrade, and `am doctor`'s version check catches a `DATABASE_URL` that still points
at 16 after the move.

## Why the app stays compatible with both

The migrations use features that exist in 16 (the app role checks read `pg_auth_members` options
that arrived in 16), and nothing depends on an 18-only default. `am backup`/`am restore` use
`pg_dump`/`pg_restore` from the image, which are version 18: a newer `pg_dump` can read an older
server, so the same image backs up a 16 install and a 18 install.

One difference is handled: `pg_dump` 18 writes `SET transaction_timeout = 0` (a 17+ setting) into
every archive, and a 16 server rejects that one statement. `pg_restore` ignores it and restores the
rest, so `am restore` accepts that exact single diagnostic — same failing statement, error count
exactly one — on a 16 target and warns. Any other error still fails the restore. This is what makes
an 18-made dump readable by a 16 install; the recommended procedure above avoids relying on it by
taking the final backup with the old 16-client image.
