---
section: Security
issues: [808, 811, 813]
---
- Copilot writes now go through the agent policy: the plain assistant acts as the workspace’s built-in Copilot agent, so the autonomy switch, the per-agent change and send limits, the guard and ownership holds, the mandate and the action ledger apply to it exactly as to any other agent; with agents switched off it is refused, and pausing that agent stops its writes. An agent principal that names no agent record can no longer run any write.
- The OTLP endpoint is logged as its origin only, so `OTEL_EXPORTER_OTLP_ENDPOINT` credentials in the userinfo or a token in the query string no longer reach the startup logs.
- Migration resets `SUPERUSER` and `BYPASSRLS` on an app role that already existed, and refuses an app role that can `SET ROLE` into a privileged one through a chain of memberships (a `NOINHERIT` middle role does not help): the error names the chain and the `REVOKE` that fixes it, so the migration — and therefore startup — stops instead of serving every request with row-level security off. When both attributes are already off the migration leaves them out of the `ALTER ROLE`, so a non-superuser `CREATEROLE` migration user can start a second time. `am doctor` fails with the same role, chain and fix.
