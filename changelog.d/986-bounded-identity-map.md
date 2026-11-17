---
section: Fixed
issues: [986]
---
- A campaign's identity resolution now reads only the campaign's own merge family and stops as soon as its mapping bound is passed, instead of loading every merge and identifier in the workspace first. A large workspace no longer spends memory on unrelated merges before the campaign summary or the holdout report can run.
