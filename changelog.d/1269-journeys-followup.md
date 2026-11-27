---
section: Fixed
issues: [1269]
---
- A `waitUntil` entered after a goal or `waitEvent` starts its own window instead of inheriting the previous goal's deadline, and every transition out of a waiting node carries only its own deadline.
- `journeys.splitResult` and `journeys.holdoutResult` read the publication barrier before and after their ClickHouse reads and withhold the verdict when anything relevant was queued, failed or published in between, so a conversion queued during the report can no longer declare a false winner.
- A resolved `waitUntil` keeps its edge across a transient retry: a matched condition cannot turn into the timeout edge because a downstream read failed.
- Score preparation re-resolves the canonical person and repeats when a merge moved them, so a merge just before the consent lookup no longer produces a false `no_lawful_basis`.
- The profile lock before a score write resolves the chain and checks `merged_into` in one statement, so a merge between the old two reads can no longer drop a score.
- A participant's savepoint opens before its graph and consent reads, so one person's failed PostgreSQL read is retried instead of rolling back the whole workspace's sweep round.
- The publication barrier can be scoped to a report's `from`/`to` window, so a dead-lettered `journey_event` row whose events are all outside the window no longer blocks a verdict; a failed row inside the window still does until it is requeued.
