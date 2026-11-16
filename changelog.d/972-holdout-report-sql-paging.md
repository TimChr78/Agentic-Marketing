---
section: Fixed
issues: [972]
---
- `campaigns.holdoutResult` chooses each person's winning holdout assignment in PostgreSQL over `profiles.merged_into`, in the same microsecond-then-profile-id order the send path uses, and computes the entrant counts and time bounds in SQL. The conversion-event pass now reads the people in bounded pages and only ships each page's profile ids and identifiers, so a long-running campaign's report no longer holds its whole assignment history in memory.
