---
section: Fixed
issues: []
---
- A `context.page`, `context.clickIds` or `context.ip` of an unexpected shape no longer holds back ingest or the event store: ingest removes the malformed part (the event is kept, with a warning) or falls back to the request address, click ids read from a wrong-typed value as absent, and one unreadable event no longer fails its whole ClickHouse sink batch, so the other events of every tenant in that batch are stored.
- The sink checks each record before the erasure filter reads it, so an older queued record with an unexpected shape is dropped and logged (workspace and event id only) while the rest of the batch reaches the store. A database or key failure still retries the whole batch.
- A page URL or user agent of the wrong type from an older record is ignored by ad conversion forwarding and by the decision API on the server and at the edge, instead of being forwarded or changing the device.
- A historical row whose `context` cannot be read no longer stops the subject-key backfill. The reader of stored context also accepts the shapes earlier releases wrote (`page.search` as parsed parameters or pairs), so a row linked to an erased person only by such a click id still gets its exclusion key and is removed by the physical purge.
- Only a queued record that can never become readable is dropped: an absent PII-traits map and a `null` profile or group id are normalized to the writer's own defaults and stored, and a workspace id the erasure filter cannot cast to a UUID is dropped before the filter runs instead of failing the batch. Drop logs carry a fixed reason and workspace/event id only.
- A message the consumer loop cannot decode is acknowledged and logged with its subject and sequence, and the rest of the batch is processed; a dependency failure still re-delivers the batch. The profile consumer also accepts a record without its PII-traits map.
