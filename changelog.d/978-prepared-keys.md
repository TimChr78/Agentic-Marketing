---
section: Changed
issues: []
---
- Prepared encryption keys for protected identity transactions: a workspace's active identity and matching data keys, and the per-person keys of the profiles a batch touches, are unwrapped before the transaction and then used from memory inside it. A key that changes in between raises a retryable error and the whole prepare-and-run pair is retried; the protected block cannot reach the key provider. This is part 1 of 3 for #978 and does not close it.
