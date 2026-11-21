---
section: Fixed
issues: [1150]
---
- `journeys.migrate` updates a `waitEvent` or `goal` participant's awaited event when the new version changes it, instead of leaving them on the removed event; it reports the people on older versions as `impact.people` and the journey's touches, and applies one batched update per version and node rather than one per participant.
