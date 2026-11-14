---
section: Fixed
issues: [899]
---
- After an upgrade that repaired duplicate brand or business-context rows, the admin UI, `workspace.get`, the workspace switcher, hosted pages and the `business-context://current` MCP resource served the renamed archived duplicate's published content. Every singleton reader now ignores archived rows and returns the active one.
