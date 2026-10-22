# Agentic-Marketing

An open-source, self-hostable, event-driven marketing platform built agent-first: every capability is available through MCP as well as a human-friendly UI (visual journey builder, MJML email editor, web personalization), backed by a real-time customer data platform with GDPR-grade consent handling.

**Status:** Phase 0 (foundations) in progress: command layer with REST + MCP + typed client, auth with MCP OAuth, versioned artifacts with approvals, audit log, secrets. Architecture, spikes and a Phase −1 demo are in place.

- Architecture: [`docs/architecture/`](docs/architecture/README.md)
- Demo: [`apps/web/`](apps/web/README.md) — `pnpm install && pnpm dev:web`
- Development (Phase 0 foundations, server, tests): [`docs/development.md`](docs/development.md)
