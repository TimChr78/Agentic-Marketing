---
section: Fixed
issues: [1027]
---
- Journey triggers, waits and goals ignore an event whose delivery is more than 7 days old, so an
  event the event stream replays after its processed-event marker was pruned can no longer enrol the
  same person again or satisfy a later wait. A refused event is acknowledged and counted in
  `am_journey_events_too_old_total`; imports that carry a historical timestamp still enrol, because
  the bound uses the server's receive time.
