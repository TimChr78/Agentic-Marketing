---
section: Fixed
issues: [750, 764, 787]
---
- Connector webhooks (Shopify, Salesforce and a generic mapping) no longer run the workspace tracking plan, so a strict plan cannot silently drop a mapped order or record while the sender is told the delivery succeeded. Senders see no status-code change: accepted deliveries still answer 200, and a replay is still a 200 that says nothing new was ingested.
- Replay protection now covers every inbound connection, not only Standard Webhooks. A byte-identical body on an `hmac-sha256` or unsigned generic webhook is answered as already received and publishes nothing; a different body publishes again. Those schemes carry no timestamp, so the dedupe window is the hot-state TTL (10 minutes).
- A hard bounce or complaint that arrives while an SMS STOP suppression already holds the number now escalates the row instead of being dropped, so a later START cannot unsuppress a number that bounced or complained.
