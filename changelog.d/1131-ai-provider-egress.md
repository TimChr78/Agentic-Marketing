---
section: Security
issues: [1131]
---
- OpenAI- and Anthropic-compatible AI providers now go through the same egress guard as webhooks, connectors and decision providers. Adding or changing a provider refuses a loopback, metadata or internal URL, and every model request is checked again when the connection is made, with DNS pinning and no redirects. A self-hosted model on a private address keeps working when its host is listed in `EGRESS_ALLOWED_HOSTS`; streaming answers, as the copilot uses, still stream.
