---
section: Fixed
issues: [601, 620, 633]
---
- A single failed alert measurement (for example a ClickHouse timeout) is retried on the next scheduler tick instead of silencing the rule for up to an hour; a rule that keeps failing backs off after three attempts and logs the failure streak once.
- Deleting an alert rule also removes its firing history, and the history list never shows episodes whose rule no longer exists (nor a raw rule id with the wrong value unit).
- Editing an alert rule keeps each e-mail channel as it was saved; renaming a rule no longer flattens several e-mail channels into one and rewrites the notification targets.
