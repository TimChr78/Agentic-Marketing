---
section: Fixed
issues: [1108]
---
- `journeys.splitResult` no longer loads every split take for a journey in one read. It walks the takes a bounded page of participants at a time and pages the takes by person, so a large split report holds a page rather than the journey's whole history. The counts are unchanged.
