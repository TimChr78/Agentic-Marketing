---
section: Changed
issues: [1001]
---
- New installs run PostgreSQL 18: Compose, the shared test stack and CI use `postgres:18`, and the
  image ships the 18 `pg_dump`/`pg_restore` (which also export a 16 server for the upgrade path).
  New clusters get data checksums by default; 18 also adds async I/O, B-tree skip scan and
  `uuidv7()`, and `pg_upgrade` keeps planner statistics. PostgreSQL 16 remains the supported
  minimum through at least June 2027.
- `am doctor` reports the PostgreSQL server version (`postgres.version`) and warns below 16; a 16
  server is reported as supported with a note that it is deprecated for new installs.
- **Breaking / manual steps for existing installs:** a PostgreSQL 16 data volume cannot be opened
  by 18. The shipped Compose file stops at the `postgres-check` service with the upgrade path
  instead of starting an empty database, and `POSTGRES_IMAGE` keeps an install on 16 until it is
  migrated. Stop every writer, take and verify a final `am backup` with the current image (a backup
  taken while traffic still arrived loses the writes after it and can bring back an erased
  profile), then restore into a **new** 18 volume while retaining the old 16 volume until the
  checks pass; set `AM_VERSION` explicitly in both directions. See
  [docs/deployment/postgres-18.md](docs/deployment/postgres-18.md). `pg_upgrade` is the advanced
  alternative and needs matching data-checksum settings (18 enables checksums for a new cluster by
  default).
