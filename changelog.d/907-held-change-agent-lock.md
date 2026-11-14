---
section: Fixed
issues: [907]
---
- A held change now re-checks the agent and publishes it in one transaction under the same per-agent lock the guardian and the policy engine use, so a guardian pause or cap — or a person's pause, resume or revoke, which take the same lock now — that commits during a veto window is no longer bypassed: the run stops before anything goes live and the approval records why.
- Every path that takes the agent lock follows one order (agent lock, then the approval row, then artifact rows, then the mandate lock), so a held run can no longer deadlock with an agent's publish request on the same artifact; a deadlock that still happens leaves the change queued for the next round instead of dropping it.
