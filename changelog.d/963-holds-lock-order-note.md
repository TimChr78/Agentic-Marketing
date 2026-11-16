---
section: Fixed
issues: [963]
---
- The held-change comment in the agent hold path now states the lock order the code enforces: the agent-policy lock first for every agent write, before the command's `impact`, which may lock artifacts. The inverse order it still described (a publish command's impact locking artifacts before the agent lock) was removed with that invariant and no longer exists, so a maintainer cannot reintroduce it from a stale note.
