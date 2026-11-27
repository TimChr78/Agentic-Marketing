---
section: Fixed
issues: []
---
- `am backup` and the scheduled backup service refuse to run while a restore is unfinished, instead of writing a normal-looking backup of a database that is not a valid restore point. The scheduled service records the run as failed, so `am backup --health` reports it.
- A backup now holds the restore lock for its whole capture, so a restore cannot start between the fence check, the Postgres dump and the ClickHouse export. A restore that arrives while a backup runs waits for it and names it.
- **Manual step:** a dedicated backup role with `BYPASSRLS` also needs `SELECT` on `public.restore_fence`; grant it with `GRANT SELECT ON public.restore_fence TO <role>`, or the backup is refused with a message naming that grant.
- A scheduled run's `lastRunAt` is written with its result, not when the run starts, so a heartbeat during a long backup never pairs a new timestamp with the previous outcome.
