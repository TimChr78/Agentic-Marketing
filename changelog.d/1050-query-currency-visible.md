---
section: Fixed
issues: [1050]
---
- `analytics.query` names a currency in `meta.currency` only when there is exactly one revenue row,
  its amount is visible and the currency is not `UNKNOWN`, as the campaign summary already did. A
  client keying suppression detection on `meta.currency === null` no longer misses a withheld
  revenue figure.
