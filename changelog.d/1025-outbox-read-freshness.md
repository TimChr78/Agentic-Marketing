---
section: Fixed
issues: [1008, 1025]
---
- A send's outcome and its message event are written in one transaction, so a mandate guardrail, the guardian or a report that reads the metric layer right after a send counts it: before, the delivery worker inserted the event into the event store after committing the status, and a decision in that window judged the agent on fewer sends than it made (a bounce in three reports 50% instead of 33.33%, and a minimum sample could pass a rate it should have held). Every message event now travels through the transactional outbox, which also retries a delivery event that the event store was unavailable for instead of losing it (#1008).
- `broadcasts.status` says that its `messages` event statistics can trail `delivery` by a moment, because message events reach the event store through the outbox (#1025).
