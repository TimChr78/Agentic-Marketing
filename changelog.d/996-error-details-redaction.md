---
section: Security
issues: [996]
---
- An error's structured `details` are now redacted and length-bounded like its message, so a credential a command echoes back (for example a parameter name passed to `recipes.preview`) no longer reaches REST, MCP or the copilot client through `details`.
