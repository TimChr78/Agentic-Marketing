---
section: Fixed
issues: [590, 629, 630, 632]
---
- Campaign analytics gives every campaign its own attribution window, even when an earlier campaign has several sending members, and keeps campaigns with recipients but no conversions in a revenue query with revenue 0 instead of dropping them (including the total row).
- A revenue campaign's holdout result counts the campaign's own goal event, so it measures conversions on an install with no conversion map published, and an event without a revenue rule counts as a conversion worth 0.
- The campaign headline, the per-member rows and the holdout card resolve conversion identity the same way, so a profile merge no longer makes one surface count a conversion the other misses: a recipient reached before a merge and a conversion stored under either profile still count, and a person reached as both profiles counts once. Identity resolution is scoped to the campaign's recipients, so unrelated merges elsewhere in the workspace no longer change the headline; above the bound for the largest supported campaign, the headline and the holdout report the same not-resolved note.
