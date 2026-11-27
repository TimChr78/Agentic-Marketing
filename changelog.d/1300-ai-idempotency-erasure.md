---
section: Fixed
issues: [1300]
---
- A retried request with an idempotency key re-checks the person it is about before a stored answer is returned. An AI score, a queued classification, a person's scores and `profiles.get` are no longer replayed for a person erased after the first call.
