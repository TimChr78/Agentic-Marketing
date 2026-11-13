---
section: Security
issues: [885]
---
- Unexpected failures no longer reach people, the audit log or the agent ledger with their own text: a database, secret-provider, event-store or provider error that used to be wrapped into a user-facing message now propagates, and the executor answers and audits it as the fixed internal failure.
- A provider's HTTP error is reduced to its own error code and message, length-limited and with token-shaped values redacted, so a gateway echoing an `access_token`, an `Authorization` header or a developer token cannot leak it to the caller or to anyone with `audit:read`. Redaction now covers `key=value`, `key: value` and JSON pairs for token, secret, password, key, auth, credential, signature and session fields; Shopify, Stripe, Slack, GitHub, AWS, Google and JWT prefixes; and shorter base64/hex runs. The complete text is redacted before it is truncated.
- OAuth token-endpoint failures are sanitised before they reach the callback page or the `oauthError` that `connections.list` returns: the provider's OAuth code plus a redacted, length-limited description when the endpoint answered, and a fixed text for a transport or other unexpected failure.
- A test e-mail's per-recipient reason uses a fixed text for an unexpected transport or render failure; a typed provider refusal keeps its own redacted diagnostic, and the all-failed message never carries raw exception text.
- A link the pre-send check cannot fetch is reported with a safe classification (DNS, refused, timeout, egress refusal) rather than the driver's `message`.
- Validation failures keep their helpful message: a domain that cannot be registered, a journey that cannot run, a template's Liquid or MJML error, an e-mail block's parameter error, a non-http push link, a not-connected OAuth connection and an unexpected failure in a mandate renewal are still explained to the person who can fix them.
