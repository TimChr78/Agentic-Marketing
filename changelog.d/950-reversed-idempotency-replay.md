---
section: Fixed
issues: [950]
---
- **Breaking:** an idempotent replay of a key whose action a person has since reversed with `agents.undo` now answers `409` with `details.reason: "idempotency_key_reversed"` instead of returning the stored response, which described something that is no longer true (for example a publish that was taken out of service again). Nothing is re-run; use a new idempotency key for the attempt you want. A key whose action is still in place replays exactly as before, and a person's keys are never reversed, because only an agent's writes have a ledger row to undo.
- The stored response of an agent write now names the ledger entry it answered, so undo knows which key to reverse. Migration 0103 adds `idempotency_keys.agent_action_id` and `idempotency_keys.reversed_at`; existing rows keep replaying.
