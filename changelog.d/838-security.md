---
section: Security
issues: [817, 818, 829, 838]
---
- **Breaking:** a write authenticated by the session cookie now has to send `Content-Type: application/json` from the app's own origin (`PUBLIC_URL`, or a `TRUSTED_ORIGINS` entry; `Sec-Fetch-Site: same-origin` is the fallback when `Origin` is absent). A form-encoded or `text/plain` post from another site is refused with 413/415 or 403 instead of running the command. The invitation and OAuth consent-workspace form endpoints accept urlencoded forms but run the same origin check; bearer and API tokens are unaffected. Better Auth's own `/api/auth/*` routes already validate Origin against the same trusted list.
- **Breaking:** a workspace autonomy draft ceiling of 0 now makes every agent observe-only: drafts are refused with a reason, with or without a mandate, while reads still work.
- `am reset-password` deletes every existing session of that person in the same operation (and nobody else's), so a cookie stolen before the reset stops working.
- Agent auto-creation on first credential use and the OAuth consent workspace choice now write as the app role under row-level security; the global cleanup of abandoned consent choices moved to the scheduler.
- The Postgres admin and application pools handle a failure of an idle pooled connection instead of exiting the process, so a database restart or failover no longer takes the server down.
- The egress guard refuses the IPv4-translated (SIIT) and local-use NAT64 forms, fails closed on anything that is not an IP address, filters resolved addresses by the requested family, and keeps internal names reachable only when the name itself is allow-listed.
- An unexpected exception in the command executor is audited as a sanitized internal failure before it is rethrown, so a failed write leaves a trace without recording SQL, secrets or stack details.
