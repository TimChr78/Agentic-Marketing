---
section: Security
issues: [931]
---
- The MCP-disabled startup warning logs `PUBLIC_URL` as its origin and path only, so basic-auth userinfo and a token in its query string no longer reach the logs. `OPENBAO_ADDR`, `CLICKHOUSE_URL`, `OTEL_EXPORTER_OTLP_ENDPOINT`, `VALKEY_URL`, `NATS_URL` and provider API bases with credentials keep authenticating (as an `Authorization` header, or the client's own options where it has them) and their failures are reported as origin plus cause code, so neither the thrown error, the startup log, a command span nor `am doctor` output contains the userinfo or query token.
