---
section: Fixed
issues: [877]
---
- The Docker smoke test no longer picks host ports before starting the stack: Docker assigns them and the script reads them back, so a port taken by another run in between can no longer fail it.
