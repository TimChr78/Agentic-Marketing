---
section: Fixed
issues: [1269]
---
- A `waitUntil` entered after a goal or `waitEvent` starts its own window instead of inheriting the previous goal's deadline, and every transition out of a waiting node carries only its own deadline.
- A resolved `waitUntil` keeps its edge across a transient retry: a matched condition cannot turn into the timeout edge because a downstream read failed.
- `ai.score` resolves the person before preparation in one statement and re-resolves once when the AI-consent lookup refuses, so a merge that commits between the first profile read and the consent read no longer produces a false `no_lawful_basis`.
- The profile lock before a score write resolves the chain and checks `merged_into` in one statement, so a merge between the old two reads can no longer drop a score.
- A participant's savepoint opens before its graph and consent reads, so one person's failed PostgreSQL read is retried instead of rolling back the whole workspace's sweep round.
