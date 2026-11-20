---
section: Fixed
issues: [1093]
---
- Old unsubscribe and preference links, topic choices, webhook consent checks, erasure requests and
  audience syncs now follow a person's merges as far as the rest of the platform does (256 hops,
  cycle-safe) instead of stopping after 20. A person merged more than 20 times deep keeps their
  preference page, their topic choice lands on the survivor, their erasure request finds them,
  their queued webhook is not suppressed as if consent were refused, and their ad audience row is
  repaired onto the survivor.
