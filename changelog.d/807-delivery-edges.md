---
section: Fixed
issues: [753, 754, 755, 766, 777, 781, 807, 812, 816]
---
- A date-time entered with an impossible calendar field is refused with the usual validation error instead of being silently rolled over: `2026-02-30`, `2026-04-31`, a non-leap `2026-02-29`, `24:00`, minute 60 and second 60 no longer move a scheduled send to another day.
- Two requests that send the same idempotency key at the same moment now run the command once; the second waits and returns the first one's response instead of running the handler again (an external effect such as a send could happen twice) and failing on the key's unique constraint.
- Retention re-reads the event store inside its deletion re-check, so a person whose page view or second form submission arrives between the round's history snapshot and the delete is kept rather than erased with the new events.
- The archive's e-mail-parts cache no longer stores a fail-closed result that only ran out of time: one slow parse used to serve escaped source for that issue until eviction, and the next request now parses it again.
- Retried push notifications carry a collapse key derived from the message id (APNs `apns-collapse-id`, FCM `android.collapse_key`), so an at-least-once retry does not show the same notification twice.
- Click ids from conversion cookies pick the first value for `_fbp` and `_ttp` as they already did for `_fbc` and `_epik`, so a legacy cookie at `/` cannot shadow the newer one at `/lp`.
- The SNS signing-certificate cache keeps its once-per-minute refetch throttle outside the certificate LRU (now 64 URLs), so certificate churn no longer turns every webhook verification into a live fetch to AWS.
- A reusable preference-centre link no longer loses segment-change events: each re-evaluation of a person's segment membership gets its own event id, so a topic toggled back within two minutes still triggers `Segment Entered`/`Segment Exited` journeys and webhooks.
- The archive sanitiser's linear-time self-test drives a synthetic clock, so a busy CI runner can no longer make it flaky.
