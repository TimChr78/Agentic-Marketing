# Architecture Decision Records

Format: short [MADR](https://adr.github.io/madr/)-style records. Status is one of `Proposed`, `Accepted`, `Superseded`.
New decisions get the next number; superseded ADRs are kept and linked.

| ADR | Title | Status |
|---|---|---|
| [0001](0001-build-vs-fork.md) | Build a new core (Dittofeed as reference) | Accepted |
| [0002](0002-modular-monolith-typescript.md) | TypeScript modular monolith with role-based processes | Proposed |
| [0003](0003-storage-and-event-bus.md) | PostgreSQL, ClickHouse, NATS JetStream, Valkey | Proposed |
| [0004](0004-journey-runtime.md) | Journey runtime on Postgres + Graphile Worker | Proposed |
| [0005](0005-command-registry-mcp.md) | One command registry for REST, MCP and UI | Proposed |
| [0006](0006-email-format-and-editor.md) | MJML + Liquid as canonical email format, GrapesJS editor | Proposed |
| [0007](0007-send-gateway-consent.md) | Single send gateway enforcing lawful basis | Proposed |
| [0008](0008-segment-compatible-ingestion.md) | Segment-spec compatible ingestion with own gateway | Proposed |
| [0009](0009-project-license.md) | Project license | Accepted |
| [0010](0010-analytics-layers.md) | Three-layer analytics | Accepted |
