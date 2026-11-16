---
section: Changed
issues: []
---
- Message decision events and double opt-in confirmation e-mails are now queued in the transaction that decides them and published by a background dispatcher, so a slow or unavailable ClickHouse or mail provider can no longer hold up or roll back a consent write, and a send is not lost when a process stops mid-request. Redelivery is safe: message events keep their stable ids and a confirmation keeps its `doi:<message>` key.
- Retention no longer deletes signups that were never confirmed. It still scans for them and reports the count (`unconfirmedSignups`), but the profiles are kept until a follow-up adds a durable activity check; plan for them to stay in the workspace for now.
- This is part 2 of 3 for #978 and does not close it.
