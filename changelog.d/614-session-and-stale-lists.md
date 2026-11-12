---
section: Fixed
issues: [595, 613, 614, 616]
---
- Signing out now clears the local session only after the server confirms it; a refused or unreachable sign-out keeps you signed in and says so, instead of claiming you signed out while the session is still live.
- Choosing a different starter recipe now shows that starter's form, even when an earlier read finishes last; a slow previous selection can no longer overwrite the parameters or preview.
- The People list drops pages cached before a person was erased, so a removed person is no longer shown as a current row.
- The copilot's token count starts at zero for a new chat and when an earlier conversation is opened, and is labelled as the current session's usage.
