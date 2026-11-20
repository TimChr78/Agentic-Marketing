---
section: Changed
issues: [1120]
---
- Better Auth moves from 1.7.23 to 1.7.25, with the core, MCP, OAuth provider, CIMD and SSO packages in one step. The update fixes OAuth provider and MCP OAuth 401 challenges not exposing `WWW-Authenticate` to browser clients on another origin, DPoP failures on deployments that keep verification values only in secondary storage, RP-initiated logout and token introspection on hosts that cannot reach their own hostname, and authorization URLs re-encoding query parameters. Verification values are now explicitly kept in the database, which the password-reset flow already relies on. `better-call` stays on the 1.4 line, the version Better Auth 1.7 requires.
