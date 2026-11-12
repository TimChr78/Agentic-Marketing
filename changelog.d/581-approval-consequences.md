---
section: Fixed
issues: [581, 583, 584, 600]
---
- The approval drawer now resolves the consent topic the way the composer and send time do: a broadcast's topic override wins over the template's own topic, so the evidence describes the actual send.
- Bundled dependencies always show the live version beside the bundled one, and an approval that would move a live version backwards says so on the row and in the summary.
- A broadcast with a send window no longer claims that arrival time varies by reader in the When row; it describes the reader's local window.
- An unresolved saved purpose is named "Unavailable purpose" in the approval consequences and the imports list, with the technical key only behind its copy control.
