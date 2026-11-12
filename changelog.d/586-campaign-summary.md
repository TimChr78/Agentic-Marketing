---
section: Fixed
issues: [586, 587, 588]
---
- The campaign evaluation's per-member rows now apply the same k-anonymity rule as the measure layer: a member that reached fewer than k=5 people has its counts and rates suppressed, `meta.suppressed` counts the hidden rows, and the page no longer claims k-protection when nothing was suppressed.
- A journey holdout now follows the same k rule as its member row: when the row is suppressed, or either arm has fewer than k=5 people, its counts, rates and lift are null, `suppressed` is true, and `meta.suppressed` counts it; the page shows "Suppressed" instead of numbers.
- Per-member counts ignore message events without a profile id, so an unprofiled send no longer adds a phantom person to the row or deflates its click and unsubscribe rates.
- `analytics.campaignSummary` clamps its documented default window to the 400-day cap (`max(campaign start, to − 400 days)`), notes when it shortened the window, returns readiness instead of rejecting a default window whose campaign starts after now, and rejects a reversed explicit window with a message that names the fix.
- The summary keeps `campaign.recipients` as people reached on any channel, but labels the e-mail figures as e-mail and computes e-mail rates and funnel shares on the e-mail base (`email.sent`/`email.delivered`), so a campaign that also sends SMS or push no longer shows recipients above e-mails delivered or divides e-mail counts by all-channel recipients.
