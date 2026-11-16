---
section: Fixed
issues: [936]
---
- A signup that leaves the consent status unchanged is kept in the ledger as a distinct action, so a delayed unsubscribe callback with an older action time no longer overrides the later signup; the same applies to imports, SDK consent events, unsubscribe callbacks and SMS STOP. Only an exact duplicate action or a redelivered event is folded, never a later action folded against an older row. Genuinely repeated signups therefore add a ledger row each; that growth is accepted so the decisive action is never lost, and consent writes for one person are serialised.
