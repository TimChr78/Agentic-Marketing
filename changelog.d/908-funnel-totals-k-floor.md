---
section: Security
issues: [908]
---
- **Breaking:** `analytics.journeyFunnel` applies the k=5 floor to its headline totals, not only to the step rows beside them. A positive total below 5 (`entered`, `goalReached`, `completed`, `exited`) is now `null`, and suppression follows the published topology: a fork’s branches add up to their parent and a reconvergence’s parents to the node, so when one branch is hidden the smallest visible term of that same relation is hidden too (never an unrelated step), a hidden entry/goal/single-exit step withholds its headline, and drop-off or rate values that need a withheld count are `null`. Without a published version every step protects every total and the note says so. `meta.suppressed` counts withheld totals and complementary steps and a note names them. API clients must handle four more nullable fields, and the journey report renders a withheld total as suppressed.
