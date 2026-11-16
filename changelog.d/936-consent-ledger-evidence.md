---
section: Fixed
issues: [936]
---
- A signup that leaves the consent status unchanged is kept in the ledger as evidence, so a delayed unsubscribe callback with an older action time no longer overrides the later signup; imports, SDK consent events, unsubscribe callbacks and SMS STOP follow the same rule. Every distinct action is kept and genuinely repeated signups add a row each; that growth is accepted. Only a redelivered event or an exact duplicate is folded: millisecond precision is the system's precision end to end, so two actions in the same millisecond with the same purpose, channel, status and source count as one. There is no time-window fold, and concurrent writers and merges are not serialised beyond what the platform already does (tracked separately).
