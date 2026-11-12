---
section: Security
issues: [673]
---
- The archive and web-version sanitiser now bounds a whole render by one clock, checks it while scanning and while walking a deep open-element stack, and decodes the whitespace entities that could hide a `meta refresh` from the scanner. Input past any bound still fails closed to escaped text.
