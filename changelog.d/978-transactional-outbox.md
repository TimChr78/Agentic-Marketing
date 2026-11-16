---
section: Changed
issues: []
---
- Message decision events and double opt-in confirmation e-mails are now queued in the transaction that decides them and published by a background dispatcher, so a slow or unavailable ClickHouse or mail provider can no longer hold up or roll back a consent write, and a send is not lost when a process stops mid-request. Redelivery is safe: message events keep their stable ids and a confirmation keeps its `doi:<message>` key.
- **The scheduler role is required to publish them.** Keep a `scheduler` replica (one, as for broadcasts): a deployment without one records consent and accepts signups but never publishes queued message events or creates the double opt-in confirmation messages. Publication normally follows within a second; transient failures retry for about 27 hours before a row is dead-lettered, and `am outbox` requeues dead letters after an outage. `am doctor` reports the backlog and failures as `queue.outbox`.
- Retention no longer deletes signups that were never confirmed. It still scans for them and reports the count (`unconfirmedSignups`), but the profiles are kept until a follow-up adds a durable activity check; plan for them to stay in the workspace for now.
- This is part 2 of 3 for #978 and does not close it.
