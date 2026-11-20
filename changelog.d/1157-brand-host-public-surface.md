---
section: Security
issues: [1157]
---
- A verified brand domain serves only its public surface: signup forms, unsubscribe and preference pages, click redirects, assets, the newsletter archive, inbound webhooks, and the public `/v1` tracking, decide, push and consent paths. The admin UI, sign-in, MCP, SCIM, OpenAPI and admin REST answer 404 on a brand host instead of falling through to the admin application.
- Path-prefixed brand domains (`/am/f/*`, `/am/hooks/in/*`, `/am/v1/*`) work on an `api` pod in a split Kubernetes deployment. Admin REST `/v1/<command>` is served by the `api` role only, and the Ingress routes only the public `/v1` paths to `ingest`.
- Upgrade note: requests that reached the admin UI or admin REST through a brand hostname must use `PUBLIC_URL` instead. Apply the new chart so the Ingress path split changes with it.
