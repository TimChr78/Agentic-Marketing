---
section: Fixed
issues: [1239]
---
- A broadcast message suppressed because the next send window opens beyond its maximum delay is
  recorded as a `suppressed` decision in the message log and in ClickHouse, so
  `broadcasts.status` and `messages.stats` count it instead of showing it as still queued.
