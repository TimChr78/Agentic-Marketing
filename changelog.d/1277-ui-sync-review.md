---
section: Fixed
issues: [1248, 1249, 1251, 1266]
---
- Single sign-on now keeps an invitation's role, resumes an MCP authorization request after signing
  in instead of sending the client back to the sign-in page, and keeps an invitation token out of
  the callback URL stored by the identity layer.
- Workspace settings keep a field the person is editing when an approval refreshes the session; a
  save submits only the fields that changed.
- A Copilot turn that changes an artifact now refreshes cached reads of that artifact too.
