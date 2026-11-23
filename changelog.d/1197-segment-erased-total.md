---
section: Fixed
issues: [1197]
---
- `segments.members` now derives a dynamic segment's total from its current `segment_memberships` rows instead of the stored `segment_runs.members` count, so an erased member and a streaming membership change are reflected immediately. The erasure no longer takes the segment membership lock or rewrites stored totals, which removes the deadlock a scheduled refresh could hit.
