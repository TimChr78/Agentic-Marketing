---
section: Fixed
issues: [965]
---
- Docker Compose and the Helm chart forward the OTLP tracing settings the server actually reads: `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` and the header lists `OTEL_EXPORTER_OTLP_HEADERS` and `OTEL_EXPORTER_OTLP_TRACES_HEADERS` now reach the container instead of being a silent no-op in `.env`. In the chart the endpoint is a `config` value and the headers are documented as `secrets.values` entries (or part of an existing Secret), because a collector Authorization header is a credential. A new guard test scans every `process.env` read in server-side source and fails when Compose or the chart does not forward it.
