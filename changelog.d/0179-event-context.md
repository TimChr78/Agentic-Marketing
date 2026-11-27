---
section: Fixed
issues: []
---
- A `context.page`, `context.clickIds` or `context.ip` of an unexpected shape no longer holds back ingest or the event store: ingest removes the malformed part (the event is kept, with a warning) or falls back to the request address, click ids read from a wrong-typed value as absent, and one unreadable event no longer fails its whole ClickHouse sink batch, so the other events of every tenant in that batch are stored.
- The sink checks each record before the erasure filter reads it, so an older queued record with an unexpected shape is dropped and logged (workspace and event id only) while the rest of the batch reaches the store. A database or key failure still retries the whole batch.
- A page URL or user agent of the wrong type from an older record is ignored by ad conversion forwarding and by the decision API on the server and at the edge, instead of being forwarded or changing the device.
- A historical row whose `context` cannot be read no longer stops the subject-key backfill: the row keeps the keys its columns provide, and the pass reaches the rows and workspaces after it.
