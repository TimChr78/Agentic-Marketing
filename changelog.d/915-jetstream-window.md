---
section: Fixed
issues: [915]
---
- The integrations guide now describes the two duplicate protections precisely: a duplicate is dropped while the hot-state store still remembers the delivery (ten minutes after it publishes). If that entry is lost, for example because the store restarted, JetStream's 120-second duplicate window is the only remaining protection, so a retry that arrives after the entry is gone and more than 120 seconds after the first publish is published again.
