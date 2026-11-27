---
section: Fixed
issues: [1300]
---
- A journey step that ends without ever building the person's context (a missing prompt, a participant that timed out before preparation, an attempt limit) stores only the starting event's name, not its properties, on the AI call row, so a person's event data is no longer kept by an exit that never checked consent.
- When an agent's mandate requires an independent AI check and the check allows the action, the agent ledger stores a fixed "Independent check passed" line instead of the model's reason, which may quote the person's data — on a successful run and when the handler then fails. A command without a fixed diagnostic keeps its stored reasons as before.
- A standalone `ai.score` writes its AI call row under the workspace identity lock and the person's profile lock and re-reads their AI consent there, so a withdrawal that commits while the model runs leaves only the billing fields on the row, as for an erased person.
