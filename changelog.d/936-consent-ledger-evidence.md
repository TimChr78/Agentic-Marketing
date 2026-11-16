---
section: Fixed
issues: [936]
---
- A signup that leaves the consent status unchanged is kept in the ledger as a distinct action, so a delayed unsubscribe callback with an older action time no longer overrides the later signup; the same applies to imports, SDK consent events, unsubscribe callbacks and SMS STOP. Genuinely repeated signups therefore add a ledger row each, and that growth is accepted. Only the same event or an action equal to the microsecond is folded (action times keep PostgreSQL's precision, not just a JS Date's milliseconds). Every consent writer takes the workspace identity lock first, before resolving the person, so writes serialise with merges and with each other; a delivery batch takes it once before touching any message or suppression row, which removes the message-row/consent-lock deadlock.
