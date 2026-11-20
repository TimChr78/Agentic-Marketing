---
section: Fixed
issues: [1027]
---
- Journey triggers, waits and goals ignore an event whose delivery is more than 7 days old, so an
  event the event stream replays after its processed-event marker was pruned can no longer enrol the
  same person again or satisfy a later wait. A refused event is acknowledged and counted in
  `am_journey_events_too_old_total`; imports that carry a historical timestamp still enrol, because
  the bound uses the server's receive time.
- An outbox row keeps the time it was queued, so a `message_event` that is delivered late, or
  requeued with `am outbox`, is judged by its original age instead of looking fresh. The trade-off is
  explicit: a backlog older than 7 days loses the journey triggers in it for good, requeueing does
  not revive them, and `am doctor` names the affected rows; re-enrol segment journeys with
  `journeys.enrollSegment`.
