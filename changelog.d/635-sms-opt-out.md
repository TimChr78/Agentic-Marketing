---
section: Security
issues: [635, 636]
---
- Marketing SMS always ends with " Reply STOP to opt out." unless the body already ends with a real opt-out instruction, so a text that merely mentions "stop" ("Don't stop reading", "Stop & Shop") can no longer ship without one.
- Inbound SMS replies are normalised before keyword matching: trailing punctuation, mixed case, fullwidth characters, surrounding emoji and a short phrase such as "Please STOP" now withdraw marketing consent and suppress the number, where only an exact first word did before; START and HELP match the same way.
