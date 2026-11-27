---
section: Fixed
issues: []
---
- `am restore` now keeps the restore-fence table out of the Postgres load itself: it reads the archive's table of contents, removes every entry for `public.restore_fence`, and restores with `pg_restore --use-list`. A backup written by a build from before the fence table was excluded still contains that table, and `pg_restore --clean` would otherwise drop the fence (leaving the restored database unfenced if the process stopped next) or copy the dump's stale row over this attempt's marker. The restore also raises its own fence row again after the load, and reports it when that fails, because a database that was already replaced must not be started without a fence.
