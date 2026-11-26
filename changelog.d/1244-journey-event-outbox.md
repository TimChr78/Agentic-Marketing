---
section: Fixed
issues: [1244]
---
- Journey step, split and goal events are queued in the same transaction as the participant state and published from the outbox with retries, so a failed ClickHouse write no longer loses split takes, conversions or funnel steps.
