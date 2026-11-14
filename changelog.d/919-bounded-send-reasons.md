---
section: Security
issues: [919]
---
- A send failure's stored reason is now bounded as well as redacted: `messages.reason` (shown as the Messages list's `lastError`), the matching `message_events` row and a push test result keep at most 300 characters of the provider's first line for e-mail, SMS and push, so a gateway that echoes a huge error body can no longer write it per failed recipient. Every other place that turns an exception into rendered or stored text is capped at 500 characters, and a test e-mail's per-recipient reason uses the same bounded helper.
