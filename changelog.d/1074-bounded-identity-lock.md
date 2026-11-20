---
section: Fixed
issues: [1074]
---
- Public unsubscribe, preference-centre, topic-link, SMS and provider-webhook requests now wait for
  the workspace identity lock for a bounded time (2 seconds for each workspace lock, so a provider webhook naming several workspaces can wait for each) and answer a retryable `503`
  with a `Retry-After` when another writer holds it. A long import or merge for one workspace can no
  longer pin public requests and pool connections indefinitely. `am_identity_lock_timeouts_total`
  reports how many requests were shed, next to the existing wait histogram.
