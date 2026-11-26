---
section: Fixed
issues: [1237]
---
- The delivery worker leases each message only when it starts sending it, and takes the next due
  message without waiting behind one another connection has locked. With the default two workers,
  a slow provider no longer turns the rest of a claimed batch into `failed` / `unknown_outcome`
  messages that were never handed to a provider; those messages are sent.
