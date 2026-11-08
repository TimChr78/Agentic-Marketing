---
section: Fixed
---

- The demo copilot no longer opens a real assistant stream with the visitor's session; streaming requests go through the demo guard and the drawer says the assistant is unavailable in the demo.
- Workspace-specific clients, including cross-brand token creation, now obey the installed transport, so the demo refuses them without a network request.
- Every demo link and navigation stays under `/demo/…`; a copied link, a new tab or a reload stays in the demo while a production path never enters it.
- Controls that change data are visibly disabled in the demo with “Demo only · changes are unavailable.” as their description, on Workspace settings, Providers, Approvals, token creation and artifact detail actions.
