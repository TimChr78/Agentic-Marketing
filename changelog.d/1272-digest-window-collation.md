---
section: Fixed
issues: [1272]
---
- The per-sponsor digest window is found again on a database whose collation is locale-aware
  (glibc `en_US.utf8`, ICU): the lookup's key range ended on U+FFFF, which such a collation gives no
  weight, so it matched nothing and a digest that failed for one sponsor was never retried.
