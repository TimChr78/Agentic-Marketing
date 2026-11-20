---
section: Fixed
issues: [1079]
---
- An agent's guardrail check now refuses (and asks a person) when the queue holds a message-event
  row for its sends that this server cannot parse, instead of silently ignoring evidence that could
  contain a bounce or complaint.
