---
section: Fixed
issues: [1143]
---
- Large CSV imports and snapshots no longer freeze the server or fail past 65,534 members: identifier lookups are chunked and indexed once, so the change events are built in linear time.
