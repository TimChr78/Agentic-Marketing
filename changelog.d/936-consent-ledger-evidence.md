---
section: Fixed
issues: [936]
---
- A signup that leaves the consent status unchanged is kept in the ledger when its action time is newer than the person's newest row, so a delayed unsubscribe callback with an older action time no longer overrides the later signup. Identical repeats within an hour add no row, and a redelivered event is recorded once; the SDK, unsubscribe and SMS STOP writers follow the same rule.
