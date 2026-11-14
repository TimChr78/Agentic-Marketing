---
section: Fixed
issues: [907]
---
- A held change now re-checks the agent and publishes it in one transaction under the same per-agent lock the guardian and the policy engine use, so a guardian pause or cap that commits during a veto window is no longer bypassed: the run stops before anything goes live and the approval records why.
