---
section: Fixed
issues: [1158]
---
- Setting only `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT` now enables OpenTelemetry tracing, as the OpenTelemetry specification and the deployment docs say, instead of silently staying off.
