# ADR-0005: One command registry for REST, MCP and UI

- Status: Accepted (validated by spike 1)
- Date: 2026-10-21

## Context
The platform must be fully operable by agents via MCP *and* by humans via a UI, with identical rules. Maintaining parallel REST, MCP and UI APIs by hand would drift.

## Decision
Every capability is a `defineCommand({ name, description, input, output, permission, effect, handler })` with zod schemas. From the registry we generate the OpenAPI/REST surface (Hono), MCP tools (official TS SDK, Streamable HTTP, OAuth 2.1), and the typed UI client. Authorization, validation, idempotency, rate limiting, audit and approval policy are enforced in the registry middleware, not in surfaces. The in-app copilot is an MCP client.

## Alternatives
- tRPC for UI + separate MCP server — two sources of truth.
- GraphQL — poorer fit for MCP tools and for LLM-friendly schemas.

## Consequences
Command design becomes the main API design activity: names, descriptions and error messages must be good for humans *and* LLMs. Large tool counts need grouping/filtering in MCP.

## Validation (spike 1, 2026-10-21)
Built and tested end to end in [`spikes/command-registry`](../../../spikes/command-registry/FINDINGS.md): one `defineCommand` drives an RPC-style REST route with OpenAPI 3.1, an MCP tool (input/output schemas, annotations) behind OAuth 2.1, and a typed UI client with no code generation. Adjustments:
- Input validation runs inside the registry's `execute`, not in the web framework, so every surface returns the same error and failures are audited; the OpenAPI document is generated from the same schemas.
- MCP uses SDK v2 / spec 2026-07-28 with a stateless per-request server.
- Agent least privilege is decided on the consent screen (clients request all advertised scopes); scope step-up is planned.
- Tenant isolation is enforced by Postgres RLS through a dedicated non-bypass database role.

## Update (0.6.1)

Scope step-up shipped after the spike: a write without its scope answers with an `insufficient_scope` challenge and a capable client asks the person to grant it. Commands also declare an `actionClass` (0.3.0), which the agent policy engine uses alongside `effect`; the handler receives the policy decision and reasons. The rest of the decision stands.
