---
section: Changed
issues: [942]
---
- **Breaking:** `prompts.test`, `ai.classify` and `ai.score` are spend actions now: each calls the workspace’s paid LLM provider, so an agent needs a mandate that grants the `spend` class. An agent with only `artifacts:write` (and, for the AI commands, `profiles:write`) and no mandate is refused with the reason and nothing is queued or sent; people run them as before. API-token authentication also writes `last_used_at` as the app role under row-level security instead of through the owner pool.
