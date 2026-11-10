---
section: Security
issues: [641]
---
- Redaction of contact and payment details before a prompt or the `ai_calls` log now reaches every depth; a cycle or an oversized value is replaced with a redaction marker instead of being passed through.
