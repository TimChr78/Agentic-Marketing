---
section: Security
issues: [1230]
---
- An ingest-only pod no longer mounts the MCP endpoint, Better Auth's `/api/auth/*` routes, the sign-in, consent and invitation pages or the OAuth discovery documents. Like REST, SCIM and the copilot, they belong to the `api` role, so anything that reaches an ingest Service outside the chart's Ingress rules cannot run commands or sign people in there.
