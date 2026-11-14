---
section: Fixed
issues: [905]
---
- A deduplicated replay of an audited read now records the same people as the call it replays. `profiles.find`, a segment preview and an unfiltered message list all keep their target on the replay's audit row, so "who looked up this person?" is answerable even when the caller retried with an idempotency key. A replayed write still writes no second audit row.
