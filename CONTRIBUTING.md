# Contributing

Thanks for helping. This page is the short version: what to install, what to run before a pull
request, and how changes are written down. [docs/development.md](docs/development.md) has the
detail.

Contributions are accepted under the [MIT licence](LICENSE), inbound = outbound, with no CLA. The
whole project, server and SDKs alike, is MIT; [ADR-0015](docs/architecture/adr/0015-mit-license.md)
records why.

Issues labelled `good first issue` and `help wanted` are a place to start, and a `question` issue
is the right place to ask one. Security problems do not go into an issue: see [SECURITY.md](SECURITY.md).

## Setup

Node.js 26 LTS and pnpm 10. Node 26 no longer ships corepack, so install the pnpm version pinned in
`packageManager` once, then install the workspace:

```bash
npm install -g --ignore-scripts "pnpm@$(node -p 'require("./package.json").packageManager.split("@")[1]')"
pnpm install
```

The server needs PostgreSQL 16, ClickHouse, NATS with JetStream and Valkey. [Run
locally](docs/development.md#run-locally) covers `.env`, the services, `pnpm dev` and the admin UI;
[the admin UI section](docs/development.md#the-admin-ui) covers the seeded server for UI work.

Tests use one shared stack per machine, shared by every checkout: run
`eval "$(scripts/test-services.sh env)"` once per shell, and each checkout's run is namespaced by
`AM_TEST_RUN`. [The shared test stack](docs/development.md#the-shared-test-stack) covers
`up`/`down`, the template databases that are kept on purpose, `TEST_PORT_OFFSET` for a second
checkout, and `scripts/test-services.sh reset` when a stack is broken.

## Checks

```bash
pnpm lint        # Biome, oxlint (promise rules), the e2e selector check and the changelog fragment check
pnpm typecheck
npx vitest run --project server apps/server/test/version.test.ts   # the file you touched
pnpm test:clean  # drop this run's leftover test databases
```

Run the file you touched rather than a whole project: the full local suite takes about 45 minutes,
and the shared stack is used by other checkouts. `pnpm test:affected:print` shows what a change
selects and why. `pnpm test:ci` is what CI runs.

The suite is a release gate, so it must give the same answer on any machine: [Determinism
rules](docs/development.md#determinism-rules). In short, every project runs in UTC, fixture data
comes from `seededRandom()` rather than `Math.random()`, and a result without a defined order is
compared with `expectUnordered()`. Test first: a fix opens with the test that fails on `main`.

## Changelog

Add a fragment instead of editing `CHANGELOG.md`:

```markdown
---
section: Added
issues: [208]
---
- The user-visible effect, in the changelog's voice.
```

`section` is one of `Added`, `Changed`, `Fixed`, `Security` or `Removed`, and the file is named
`changelog.d/<issue>-<slug>.md`. The format and the checks are in
[changelog.d/README.md](changelog.d/README.md); a release folds the fragments into the changelog and
deletes them.

## Commits and pull requests

- One task per pull request, from a branch off `main` named after the issue, for example
  `fix/1008-outbox-freshness` or `docs/208-contributor-scaffolding`.
- Commit subjects follow the log: `type(scope): what changed (#123)`, lower case and imperative,
  with an optional area as the scope. The types in the log are `fix`, `feat`, `docs`, `test`,
  `chore`, `build`, `ci`, `refactor` and `release` (a release commit); the issue number goes in
  parentheses when there is one.
- The pull request body uses [the template](.github/pull_request_template.md): what changed and why,
  how it was tested (the commands and their outcomes), upgrade notes, and `Closes #<issue>`.
- CI runs on every pull request. One that only changes Markdown, `docs/` or `.claude/` skips the
  slow jobs, so documentation and configuration land quickly.
- Database changes are forward-only migrations; see
  [packages/db/migrations/README.md](packages/db/migrations/README.md) and
  [Migrations](docs/development.md#migrations).
- Never edit `CHANGELOG.md`, an applied migration, or `docker-compose.yml` — site-specific Compose
  settings go in `compose.override.yaml`.

## Releases

Releases are cut from `main` by pushing a `v<version>` tag or by running **Actions → Release**,
which runs the same CI, builds the multi-arch image, and packages the Compose bundle and Helm chart.
The steps, and what a release must record, are in [Releasing](docs/development.md#releasing). What a
release contains is in the [changelog](CHANGELOG.md); upgrading is in [UPGRADING.md](UPGRADING.md),
and each release's notes carry an **Upgrading from** block.
