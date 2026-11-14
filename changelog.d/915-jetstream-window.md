---
section: Fixed
issues: [915]
---
- The integrations guide no longer claims JetStream drops a duplicate after a lost store key without qualification: Shopify and Salesforce duplicates are dropped only within JetStream's 120-second duplicate window, and a retry that arrives later (after the store key was lost and the ten-minute memory has passed) is published again.
