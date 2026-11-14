---
section: Fixed
issues: [917]
---
- **Breaking:** `ads.performance` now distinguishes a conversion that had a campaign touch from one that had none. `unattributed` keeps its name and means only conversions with no campaign touch in the window; a new `unmatched` object counts the conversions whose last touch names a campaign with no spend row, and `totals` remains the sum of the campaign rows. A spend read that stops at its provider page ceiling is no longer silent: `ads.importSpend` returns `truncated`, and `ads.performance` returns `spendTruncated` with a note that cost is incomplete, CPA understated and ROAS overstated. The page ceilings were raised (Meta 200 pages, Google Ads 50), and the flag is carried in the connection's settings JSON rather than a migration.
