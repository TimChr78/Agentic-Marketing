---
section: Security
issues: [901]
---
- **Breaking:** `campaigns.holdoutResult` applies the k=5 floor to revenue per currency, keyed on the distinct people who converted in that currency in that arm, exactly like `analytics.query` and `analytics.campaignSummary`. A currency below the floor keeps its key with a `null` amount instead of publishing one buyer's exact spend, and the result gains `suppressedRevenue` with the count and a note naming each currency. The web evaluation and broadcast report cards render a suppressed amount as suppressed, never as zero.
