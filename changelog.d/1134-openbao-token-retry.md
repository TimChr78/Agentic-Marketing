---
section: Fixed
issues: [1134]
---
- The OpenBao key provider reads its token file again after a transient failure instead of caching the error and failing every wrap and unwrap until the process restarts.
