---
section: Fixed
issues: []
---
- `am backup` and the scheduled backup service refuse to run while a restore is unfinished, instead of writing a normal-looking backup of a database that is not a valid restore point. The scheduled service records the run as failed, so `am backup --health` reports it.
