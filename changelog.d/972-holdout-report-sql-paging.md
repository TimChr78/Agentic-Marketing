---
section: Fixed
issues: [972]
---
- `campaigns.holdoutResult` chooses each person's winning holdout assignment in PostgreSQL over `profiles.merged_into`, in the same microsecond-then-profile-id order the send path uses, and computes the entrant counts and time bounds in SQL. The conversion-event and unsubscribe reads now run one bounded page of people at a time, fold each event page as it arrives, and keep only per-currency buyer counts saturating at k, so a long-running campaign's report no longer holds its whole assignment history, every conversion or every unsubscriber in memory.
