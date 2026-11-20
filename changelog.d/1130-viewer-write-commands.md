---
section: Security
issues: [1130]
---
- Write commands no longer run on `artifacts:read` alone for people. `agents.memory.add`, `agents.memory.delete`, `agents.subscribe` and `agents.unsubscribe` need `artifacts:write`, and `ai.review` needs `artifacts:approve` or `artifacts:write`. An agent still manages its own memory and subscriptions with its read scope, and a hosted agent's trigger subscription can no longer be deleted directly with `agents.unsubscribe`; change the agent's triggers instead.
