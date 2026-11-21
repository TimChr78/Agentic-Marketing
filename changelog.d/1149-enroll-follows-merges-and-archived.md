---
section: Fixed
issues: [1149]
---
- `journeys.enroll` resolves merged-away profile ids to the surviving person before re-entry, holdout and participant checks, and deduplicates the result, so re-entry limits and control-group arms cannot be bypassed through an old id. Both `journeys.enroll` and `journeys.enrollSegment` now refuse an archived journey.
