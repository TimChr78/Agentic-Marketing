---
section: Fixed
issues: [1223]
---
- `am restore` now reports a cleanup job whose snapshot row was still unfinished as queued for another sweep, instead of counting it among the "completed job(s) restored without another sweep" it just re-opened.
