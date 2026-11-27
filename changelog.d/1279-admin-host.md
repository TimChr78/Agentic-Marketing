---
section: Fixed
---
- With Host checking active, the admin and API surface (UI, auth, MCP, SCIM and admin REST) answers only on `PUBLIC_URL`'s host. Any other Host that is neither that host, a verified brand domain nor the fallback links host gets a 404 instead of falling through to the admin routes; the health probes keep answering on every Host, and the metrics scrape on the pod IP, the Service name and the fallback links host (`METRICS_TOKEN` is its guard) (#1279).
- **Manual step:** before upgrading, set `PUBLIC_URL` to the name you sign in through; once Host checking is active, every other name gets 404 for the admin surface. That includes a LAN name or IP, an internal alias, and a bare install whose `PUBLIC_URL` still defaults to `localhost` (#1279).
- `.env.example` marks the development `DATABASE_URL` and `TRUSTED_ORIGINS` as commented examples, so a bare non-Compose install no longer picks up misleading values from a copied template (#1279).
