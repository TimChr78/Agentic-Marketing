---
section: Security
issues: [964]
---
- A failed alert member e-mail stores at most 300 characters of the provider's first line in `messages.reason` and in the `alert_events.notified` entry, redacted as before, using the same `failureText` as every other send path. A source guard fails a hand-rolled `redactCredentials(...).split('\n')[0]` without a length cut.
