---
section: Fixed
issues: [591]
---
- The journey funnel reports drop-off only for a straight-line published journey, where every node has one outgoing step and no node repeats. A branch, split, alternative wait/action exit, loop or reconvergence now returns reach per node in breadth-first order with null drop-off, so a 70/30 split that reconverges no longer reports a negative drop-off. Counts use only the published version when journey events record one.
