---
section: Fixed
issues: [1111]
---
- `audiences.import` and `audiences.remove` now count matched selectors rather than the people left after a mid-call merge, so `added + existing` and `removed + notMembers` add up when a merge folds two resolved ids into one person. Their output descriptions say what the merge case means, matching `audiences.add`.
