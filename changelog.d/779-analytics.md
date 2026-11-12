---
section: Fixed
issues: [760, 779, 780, 786]
---
- `campaign.converters` and `campaign.conversion_rate` are a campaign total again: currency partitions only the revenue roll, so requesting `campaign.revenue` (or `campaign.revenue_per_recipient`) no longer splits converters per conversion currency or divides a per-currency count by the all-channel recipients. The same campaign now reports the same converter count and rate with and without a revenue measure.
- `ads.performance` reads conversion events through the paged `(timestamp, event_id)` reader, so a report window with more than 100,000 conversions counts every event instead of an arbitrary 100,000-row slice.
- Campaign-source freshness is scoped to `sent` and `delivered`, the events the recipient count reads, so a later `failed`, `queued` or `skipped` send decision cannot become the “latest event in period”; an empty match now returns null rather than 1970-01-01.
- `analytics.campaignSummary` includes an archived campaign when it is requested by id, so its headline, funnel and revenue describe the same members as its member rows instead of a zero headline beside populated rows.

- After upgrading, expect these numbers to change: `campaign.converters` and `campaign.conversion_rate` rise to the campaign total on every per-currency row (for example DKK/EUR rows that reported 2 and 1 converters and rates 0.2/0.1 for a 10-recipient campaign now both report 3 converters and 0.3); `ads.performance` conversions, revenue, CPA and ROAS can rise for windows above 100,000 conversion events; campaign freshness moves back to the last `sent`/`delivered` event for SMS- or push-only campaigns; and an archived campaign’s summary headline becomes non-zero and matches its member rows.
