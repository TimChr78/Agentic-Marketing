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
| [GHSA-w5hq-g745-h8pq](https://github.com/advisories/GHSA-w5hq-g745-h8pq) | `uuid` < 11.1.1 | Only in `spikes/email-editor`, which is not installed in CI or the image. |

mjml 5, now used for every compile, fixed the `mj-include` traversal ([GHSA-45h5-66jx-r2wf](https://github.com/advisories/GHSA-45h5-66jx-r2wf)) and no longer uses `html-minifier`, whose ReDoS ([GHSA-pfq8-rq6v-vf5m](https://github.com/advisories/GHSA-pfq8-rq6v-vf5m)) had no patch. The `mjml` package still depends on `mjml-cli`, whose ranges for `minimatch` ([GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249)) and `glob` ([GHSA-3g3m-2fjr-6pw4](https://github.com/advisories/GHSA-3g3m-2fjr-6pw4)) stop short of the patched releases; `pnpm.overrides` in `package.json` pins `minimatch` 11.0.1 and `glob` 14.0.2 for every package that asks for them, so no exception is needed. The server never loads the command-line tool: `mjml`'s library entry does not require it, and this repository only imports the library.

Every compile still passes `ignoreIncludes: true`, because a template is user content that must never read a file; `packages/email/test/render.test.ts` fails if that changes. When a fix ships, upgrade and remove the entry.
