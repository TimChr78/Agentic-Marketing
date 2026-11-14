---
section: Security
issues: [908]
---
- **Breaking:** `analytics.journeyFunnel` applies the k=5 floor to its headline totals, not only to the step rows beside them. A positive total below 5 (`entered`, `goalReached`, `completed`, `exited`) is now `null`, and when exactly one step row is suppressed the smallest visible step is suppressed with it, so no total minus the visible steps recovers the hidden count. Drop-off and drop-off rate that would need a withheld count are `null`; `meta.suppressed` counts the withheld totals and a note names them. API clients must handle four more nullable fields, and the journey report renders a withheld total as suppressed.
