---
section: Fixed
issues: [1161]
---
- The bind-mount example in `compose.override.example.yaml` mounts the PostgreSQL data directory on `postgres-check` read-only too, so the PostgreSQL 16→18 guard inspects the data that 18 will open instead of an empty named volume.
- The example now says to widen the admin bind by setting `AM_BIND` in `.env`, rather than editing the release `docker-compose.yml`.
- If you copied block (b) into `compose.override.yaml`, add the same read-only mount to `postgres-check` before upgrading PostgreSQL from 16 to 18.
