---
section: Changed
issues: [1037]
---
- Prepares the 0.17.0 erasure completion contract without activating it (#1037, part 1 of 3). An erasure now records a durable ledger of `HMAC_exclusion` values under a separate, workspace-scoped exclusion key — the merged profile family, anonymous and user ids, alias previous ids, supported ad click ids, and e-mail/phone — that no grace window prunes, that a matching-key rotation cannot invalidate, and that a restore replays without raw identifiers. ClickHouse gains a generation-versioned erased-subjects table and defaulted subject-key columns on events, message events and journey events, filled by new writes and by a resumable, app-side backfill of historical rows. Reads are unchanged and `profiles.erasureStatus` keeps its current meaning until the later parts ship.
