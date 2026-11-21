---
section: Security
issues: [1147]
---
- Campaign member rows now count only people actually sent or delivered to toward the k-anonymity floor, so a member with fewer than k real sends stays hidden even when many suppressed or failed attempts exist. Goal-event lookups are also bounded to the campaign's time window and attribution period instead of merging all history.
