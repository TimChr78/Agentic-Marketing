---
section: Fixed
issues: [1050]
---
- `analytics.query` names a currency in `meta.currency` only when every revenue row has a visible
  amount and all rows share one known currency (not `UNKNOWN`), as the campaign summary already
  did. A client keying suppression detection on `meta.currency === null` no longer misses a
  withheld revenue figure, and a dimensioned all-EUR result still names EUR.
