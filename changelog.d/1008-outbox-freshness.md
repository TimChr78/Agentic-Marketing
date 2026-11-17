---
section: Fixed
issues: [1008]
---
- An agent's mandate guardrails and the guardian judge a bounce, complaint or unsubscribe that is committed but not yet published to ClickHouse: while the agent's own message events are still queued in the outbox, or when a row was dead-lettered, the check also counts the message log and consent ledger. The verdict can only get stricter, and its reason says which evidence it used, so a send is never allowed on incomplete data. The guardian caps the agent on that evidence instead of waiting for publication.
- `alerts.list` and every evaluation sweep now report how far message-event publication is behind — the number of events still waiting, the number dead-lettered, and the age of the oldest — so a rule that is not firing during an outbox or ClickHouse outage reads as unknown rather than healthy. The Alerts page shows the same note while it is behind.
