---
section: Fixed
issues: [1137]
---
- Adding, importing or snapshotting a static audience can no longer deadlock against a profile merge or erasure: when a merge points at an id lower than one already held, the command releases its row locks and re-locks the whole set in ascending order.
