---
section: Security
issues: [808, 811, 813]
---
- Copilot writes now go through the agent policy: the plain assistant acts as the workspace’s built-in Copilot agent, so the autonomy switch, the per-agent change and send limits, the guard and ownership holds, the mandate and the action ledger apply to it exactly as to any other agent; with agents switched off it is refused, and pausing that agent stops its writes. An agent principal that names no agent record can no longer run any write.
- The OTLP endpoint is logged as its origin only, so `OTEL_EXPORTER_OTLP_ENDPOINT` credentials in the userinfo or a token in the query string no longer reach the startup logs.
- Migration resets `SUPERUSER` and `BYPASSRLS` on an app role that already existed, and `am doctor` (and the migration) fail with the role and the fix when the app role can still bypass row-level security.
