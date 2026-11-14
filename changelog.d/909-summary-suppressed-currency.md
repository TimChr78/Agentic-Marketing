---
section: Security
issues: [909]
---
- **Breaking:** a currency whose revenue the per-currency k=5 floor suppressed no longer disappears from `analytics.campaignSummary`: it keeps a `{currency, amount: null}` row in `headline.revenue` and `headline.revenuePerRecipient`, so two currencies can never look like one. A revenue goal's `targetProgress` is computed only when there is exactly one currency in total and its amount is visible, `meta.currency` stays `null` when any currency is suppressed, and the evaluation screen shows a suppressed currency as suppressed and withholds progress.
