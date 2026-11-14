---
section: Security
issues: [903]
---
- Events a connector maps from a provider payload no longer skip the published tracking plan's personal-data deletion. A strict plan still does not reject them (unknown event, unknown property, required or type), but every property the plan declares `pii: true` is removed before the event is stored and exported, so a custom-named property such as `customer_email` no longer reaches the event store or the warehouse in plaintext.
