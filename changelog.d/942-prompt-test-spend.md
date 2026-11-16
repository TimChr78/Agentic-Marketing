---
section: Changed
issues: [942]
---
- **Breaking:** `prompts.test` is a spend action now: an agent needs a mandate that grants the `spend` class, because a queued test run calls the workspace’s paid LLM provider. An agent with only `artifacts:write` and no mandate is refused with the reason and nothing is queued; people run it as before. API-token authentication also writes `last_used_at` as the app role under row-level security instead of through the owner pool.
