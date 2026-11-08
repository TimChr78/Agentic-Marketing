---
section: Fixed
---

- A segment estimate completion is now matched by request identity, not only by the rules it was asked for: an obsolete response for earlier rules can no longer settle a newer estimate that happens to be for the same rules, so the newer count still arrives as current. Also pinned the conservative picker-index behaviour for an artifact id with an unknown type prefix: pending indexes are reloaded while loaded indexes that do not hold the id stay untouched.
