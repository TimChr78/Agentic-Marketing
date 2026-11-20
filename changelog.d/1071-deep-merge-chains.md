---
section: Fixed
issues: [1071]
---
- Message delivery now resolves a person through the same merge walk as holdouts and reports (256 hops, cycle-safe) instead of stopping after 20 merges. Someone merged more than 20 times deep receives their mail instead of being recorded as having no profile, so a broadcast's treatment and holdout groups count people who could actually be contacted.
