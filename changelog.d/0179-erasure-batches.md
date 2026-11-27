---
section: Fixed
issues: [1205]
---
- `profiles.erase` now completes for a person whose profile carries a very large number of identifiers: the erasure tombstones, the erasure-key ledger and the suppression hashes are written in batches, and every identifier and merged-family list is bound once as an array instead of one parameter per value. The stage no longer fails with a database parameter-limit error on every attempt, so the person can be erased and the ledger is recorded in full.
- The erasure cleanup that follows a very large identifier history now completes too: the ClickHouse publication check, the event sweep and the physical purge work in bounded requests, the physical purge matches the exact committed ledger keys even before they are published, and the hot-state snapshot delete is split into batches. These steps previously failed on their own request or call limit, so the exclusion was never confirmed and the cleanup could not finish.
