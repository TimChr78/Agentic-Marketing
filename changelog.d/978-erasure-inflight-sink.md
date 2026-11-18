---
section: Fixed
issues: []
---
- Mitigates erased people's events reappearing in ClickHouse while the full read-time exclusion ships in 0.17.0 (#1037). The ClickHouse sink drops events naming an erased person before storing them, but keeps an event when one of its identifiers belongs to a live profile; journey and message writers skip profiles that no longer exist; person-linked inserts are synchronous (`async_insert=0`); and the cleanup records its first successful sweep and re-sweeps after the mitigation interval before reporting `complete`. `complete` now arrives about 35 seconds later. This narrows the window but does not guarantee that a write already in flight at the ClickHouse server, or an eligibility check that ran before the erasure, can never land later.
