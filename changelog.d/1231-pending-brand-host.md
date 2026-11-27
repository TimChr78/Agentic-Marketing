---
section: Security
issues: [1231]
---
- A brand hostname that is registered but not yet verified now serves only its verification challenge and the public paths. The admin UI, auth, MCP, SCIM, OpenAPI and admin REST answer 404 on it, just as they do once the hostname is verified, so a hostname waiting in `ingress.extraHosts` never exposes the admin surface.
