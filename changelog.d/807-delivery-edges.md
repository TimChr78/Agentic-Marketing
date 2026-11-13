---
section: Fixed
issues: [753, 754, 755, 766, 777, 781, 807, 812, 816]
---
- A date-time entered with an impossible calendar field is refused with the usual validation error instead of being silently rolled over: `2026-02-30`, `2026-04-31`, a non-leap `2026-02-29`, `24:00`, minute 60 and second 60 no longer move a scheduled send to another day. Lowercase `t` and `z` are accepted, as the ISO parser already did.
- Two requests that send the same idempotency key at the same moment now run the command once, including read commands (whose snapshot used to predate the winner's commit); the second waits and returns the first one's response instead of running the handler again (an external effect such as a send could happen twice) and failing on the key's unique constraint.
- Retention re-reads the event store inside its deletion re-check, so a person whose page view or second form submission arrives between the round's history snapshot and the delete is kept rather than erased with the new events.
- The archive's e-mail-parts cache now keeps a fail-closed result that only ran out of time for a minute, so an always-slow issue costs one parse per minute rather than one per request; after the minute it is parsed again and can succeed.
- Retried push notifications carry a per-message key (APNs `apns-collapse-id`, FCM `android.notification.tag`), so an at-least-once retry replaces the first notification instead of showing it twice. FCM ignores `collapse_key` for notifications with a payload, so the Android tag is what deduplicates a display message.
- Click ids from conversion cookies pick the first value for `_fbp` and `_ttp` as they already did for `_fbc` and `_epik`, so a legacy cookie at `/` cannot shadow the newer one at `/lp`.
- The SNS signing-certificate cache keeps its once-per-minute fetch throttle outside the certificate LRU (now 64 URLs) and checks it before a cache-miss fetch too, so certificate churn no longer turns every webhook verification into a live fetch to AWS; a full map of unexpired cooldowns refuses the fetch and lets SNS retry.
- A reusable preference-centre link no longer loses segment-change events: each re-evaluation of a person's segment membership gets its own event id, so a topic toggled back within two minutes still triggers `Segment Entered`/`Segment Exited` journeys and webhooks.
- The archive sanitiser's linear-time self-test drives a synthetic clock, so a busy CI runner can no longer make it flaky.
