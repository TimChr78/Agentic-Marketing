---
section: Fixed
issues: [1214]
---
- A backup's `pg_dump` now announces `application_name = am-backup` instead of `am-restore`, so a running backup no longer makes a restore wait for the drain bound and refuse with "a previous restore's work is still running". A restore that starts during a backup waits for it and says "a backup is still running", because replacing the database under a dump would leave the backup incomplete.
