# Security

## Reporting a vulnerability

Please do not open a public issue for a security problem. Report it privately through GitHub: **Security → Report a vulnerability** on [this repository](https://github.com/TimChr78/Agentic-Marketing/security/advisories/new). Include what you found, how to reproduce it, and the version or commit.

You will get an answer within a week. Once a fix is released, the advisory is published with credit to you, unless you prefer otherwise.

## Supported versions

While Agentic Marketing is 0.x, only the latest release gets security fixes. Upgrade to it before reporting a problem in an older one.

## Scope

In scope: this repository's server, web UI, browser SDK, edge worker and Helm chart, including permission checks, row-level isolation between workspaces, consent enforcement, the egress guard, and the handling of secrets and personal data.

Out of scope: problems in Postgres, ClickHouse, NATS, Valkey or third-party providers themselves, and deployments that disable the documented protections (for example `EGRESS_ALLOWED_HOSTS` opening private networks, or a `MASTER_KEY` stored in the repository).

## Dependency advisories

CI runs `pnpm audit --prod --audit-level=moderate`, and Dependabot opens weekly update PRs. Advisories that cannot be fixed by an upgrade yet are listed in `pnpm.auditConfig.ignoreGhsas` in `package.json`, each with the reason here:

| Advisory | Package | Why it is accepted |
|---|---|---|
| [GHSA-pfq8-rq6v-vf5m](https://github.com/advisories/GHSA-pfq8-rq6v-vf5m) (ReDoS) | `html-minifier`, via `mjml-core` 4 | No patched version exists. The minifier only runs with `minify: true`; `packages/email/src/render.ts` always compiles with `minify: false`. |
| [GHSA-45h5-66jx-r2wf](https://github.com/advisories/GHSA-45h5-66jx-r2wf) (`mj-include` traversal) | `mjml` 4.18 | Fixed only in mjml 5, whose async API and different HTML output need their own release. Every compile passes `ignoreIncludes: true`. |
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid` < 11.1.1 | Only in `spikes/email-editor`, which is not installed in CI or the image. |

`packages/email/test/render.test.ts` fails if either mjml mitigation is removed. When a fix ships, upgrade and remove the entry.
