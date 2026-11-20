---
section: Fixed
issues: [1062]
---
- An erasure whose exclusion publication ran out of retries is re-opened on a periodic scheduler
  pass instead of only at start, so ClickHouse soon stops returning the person.
- `am doctor` now says that the person's queued events and reads still include them until the
  exclusion publishes, and `/metrics` reports `am_erasures_unpublished`.
