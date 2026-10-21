# ADR-0005: One command registry for REST, MCP and UI

- Status: Proposed
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
