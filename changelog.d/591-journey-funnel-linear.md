---
section: Fixed
issues: [591]
---
- The journey funnel reports drop-off only for a straight-line published journey, where every node has one outgoing step and no node repeats. A branch, split, alternative wait/action exit, loop or reconvergence now returns reach per node in breadth-first order with null drop-off, so a 70/30 split that reconverges no longer reports a negative drop-off. Counts use only the published version when journey events record one.
- A linear published journey also needs non-increasing counts along the walk. Migration moves a participant to the new version without a new entry, so a later step can outnumber the entry step; when that happens the report returns `basis: "reach"` with null drop-off and a note that people joined mid-journey, instead of clamping the excess to a fabricated zero drop-off. A negative drop-off is never silently turned into zero.
