# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: **Security → Report a vulnerability** on [this repository](https://github.com/TimChr78/Agentic-Marketing/security/advisories/new). Include what you found, how to reproduce it, and the version or commit.

You will get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

While Agentic Marketing is 0.x, only the latest release gets security fixes. Upgrade to it before reporting a problem in an older one.

## Scope

In scope: this repository's server, web UI, browser SDK, edge worker and Helm chart, including permission checks, row-level isolation between workspaces, consent enforcement, the egress guard, and the handling of secrets and personal data.

Out of scope: problems in Postgres, ClickHouse, NATS, Valkey or third-party providers themselves, and deployments that disable the documented protections (for example `EGRESS_ALLOWED_HOSTS` opening private networks, or a `MASTER_KEY` stored in the repository).
