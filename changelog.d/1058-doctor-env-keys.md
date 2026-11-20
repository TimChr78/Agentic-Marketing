---
section: Fixed
issues: [1058]
---
- `am doctor --env-file` no longer reports `BETTER_AUTH_TRUSTED_ORIGINS`,
  `OTEL_EXPORTER_OTLP_TRACES_ENDPOINT`, `OTEL_EXPORTER_OTLP_HEADERS` and
  `OTEL_EXPORTER_OTLP_TRACES_HEADERS` as unknown or obsolete. They are documented as commented keys
  in `.env.example`, so the pre-upgrade check stops telling operators to remove working OTLP
  credentials, and knows which release introduced each key.
