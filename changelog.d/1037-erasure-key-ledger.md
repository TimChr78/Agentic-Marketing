---
section: Changed
issues: [1037]
---
- Prepares the 0.17.0 erasure completion contract without activating it (#1037, part 1 of 3). An erasure now records a durable, pseudonymous key ledger — the merged profile family, anonymous and user ids, and the matching key's e-mail/phone hashes with their key version — that no grace window prunes and a restore replays. ClickHouse gains an idempotently published erased-subjects table and defaulted subject-key columns on events, message events and journey events, filled by new writes and by a resumable, batched backfill of historical rows. Reads are unchanged and `profiles.erasureStatus` keeps its current meaning until the later parts ship.
