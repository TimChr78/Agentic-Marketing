---
section: Changed
issues: [727]
---
- The rest of the grouped dependency update from #720 lands: OpenTelemetry `sdk-node` and the OTLP trace exporter move from 0.223 to 0.301, the Anthropic SDK from 1.0 to 1.8, Vite from 8.3.5 to 8.3.8, Biome from 2.5 to 2.6, Playwright from 1.64 to 1.65, and Vitest from 5.0 to 5.1, together with the current minors of the AI SDK, Hono, the MCP SDK, Tailwind, React Flow, GrapesJS, lucide, zustand and the e-mail, ClickHouse and parser libraries.
- OpenTelemetry tracing now also reports `os.*` and `service.instance.id` resource attributes, and requires Node.js 22.15 or newer when it is enabled. Nothing needs to change in the tracing configuration.
- Biome 2.6 formats and lints the same code apart from the mechanical fixes in this release; no rule was disabled.
