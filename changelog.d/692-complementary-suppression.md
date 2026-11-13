---
section: Security
issues: [692]
---
- **Breaking:** small-group suppression is complementary. When exactly one row of a dimensioned analytics result is below k=5, the smallest visible row is hidden as well, so a reader can derive only the sum of the hidden rows instead of either one; `meta.suppressed` counts both and a note says why. The same rule applies to the member rows of `analytics.campaignSummary`, where a campaign with 10 recipients and member rows of 6 and 4 now hides both rows while the recipients total stays visible. API clients must handle one more nullable row in reports. Totals stay visible, and the two-arm holdout and split views already withhold both arms and every comparison when an arm is below k.
