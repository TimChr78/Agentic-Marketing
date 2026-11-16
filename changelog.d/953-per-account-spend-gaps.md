---
section: Fixed
issues: [953]
---
- Spend-gap warnings now belong to the accounts a report actually reads: `ads.performance` matches a stored gap per (platform, account) against the workspace's Meta and Google connections, and the note names the account. A gap kept after a connection was re-pointed or deleted (its partial spend still feeds reports) no longer makes every report warn with `spendTruncated: true` and a remedy no import could carry out. The rows are kept as history; a person can clear one with the new people-only `ads.spendGaps.clear` command, which leaves the stored spend untouched.
