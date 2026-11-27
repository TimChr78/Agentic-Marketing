---
section: Fixed
issues: []
---
- `am restore` raises its restore-fence row again immediately after the Postgres load. A backup written by a build from before the fence table was excluded still contains that table, and `pg_restore --clean` could drop it or replace this attempt's row: a later failure then left the restored database unfenced, and a completed restore could stay fenced with the dump's stale row. The fence the restore clears at the end is now always the one it raised.
