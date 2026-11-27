---
section: Fixed
issues: [1238]
---
- The delivery worker chooses the workspaces that have mail it can send now, oldest work first,
  and continues after the last one on the next round. A workspace holding only mail for a quiet
  hour or a send window no longer takes a place in the round, so workspaces beyond the first 100
  keep getting their mail.
