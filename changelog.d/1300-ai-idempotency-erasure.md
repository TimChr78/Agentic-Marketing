---
section: Fixed
issues: [1300]
---
- A retried request with an idempotency key re-checks the person it is about before a stored answer is returned. An AI score, a queued classification, a classification's stored answer, the AI call log, the AI review list, a person's scores and `profiles.get` are no longer replayed for a person erased after the first call. An empty score list holds no person data, so it still replays.
