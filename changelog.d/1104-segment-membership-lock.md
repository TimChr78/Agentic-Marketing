---
section: Fixed
issues: [1104]
---
- A segment refresh and the incremental membership update that runs as people's events arrive no
  longer deadlock on the same segment. Every writer of one segment's membership rows now takes a
  short database lock for that segment, so a refresh, a list edit, an import, a snapshot refresh and
  a live event batch finish one after the other instead of each holding a row the other is waiting
  for. The e2e seed also retries the retryable "another change locked the same artifacts" answer
  instead of failing on it.
