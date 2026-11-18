---
section: Changed
issues: [1037]
---
- Prepares the 0.17.0 erasure completion contract without activating it (#1037, part 1 of 3). An erasure now records a durable ledger of `HMAC_exclusion` values under a separate, workspace-scoped exclusion key — the merged profile family, anonymous and user ids, alias previous ids, supported ad click ids, and e-mail/phone — that no grace window prunes, that a matching-key rotation cannot invalidate, and whose wrapped key a restore keeps with the ledger. ClickHouse gains a generation-versioned erased-subjects table and defaulted subject-key columns with explicit coverage on events, message events and journey events; historical rows are backfilled into an identity-keyed side table instead of being rewritten, and revalidated until covered. Reads are unchanged and `profiles.erasureStatus` keeps its current meaning until the later parts ship.
