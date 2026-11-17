---
section: Fixed
issues: [1008]
---
- An agent's mandate guardrails and the guardian see the bounce, complaint or unsubscribe the agent's own transaction just recorded, even while the outbox has not published it to ClickHouse yet: a check snapshots the agent's queued message events before reading the metric layer and hands them to the same query, so soft bounces, broadcast reach counted in people, the measurement window and the event de-duplication all mean exactly what they will mean after publication. A dead-lettered row is counted too (its events are facts, even when it will never publish), and a verdict whose evidence needs more queued events than one check reads refuses the send with the reason instead of deciding on part of it.
- `alerts.list` and every evaluation sweep report how far message-event publication is behind — the number of events still waiting, the number dead-lettered and the age of the oldest — so a rule that is not firing during an outbox or ClickHouse outage reads as unknown rather than healthy. The Alerts page shows the same note while it is behind.
