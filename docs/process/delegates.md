# Phase workflow with delegate tasks

How a phase moves from plan to release when several delegate tasks (subagents) build it in
parallel. The integrator is the agent running the phase; delegates are the agents writing one task
each. The aim is to let CI validate every task on its own as soon as it exists, and to keep shared
files out of the way of parallel work.

## Branches and pull requests

```
main
 └── feat/phase-<n>                 phase branch: the integration point
      ├── <task branch>  →  draft PR into feat/phase-<n>  →  CI  →  review  →  merge
      └── …
 └── PR feat/phase-<n> → main       one full review and CI run, then the release

main (or a release tag)
 └── patch/<x.y.z>                  patch branch: fixes for one released version
      ├── <task branch>  →  draft PR into patch/<x.y.z>  →  CI  →  review  →  merge
      └── PR patch/<x.y.z> → main   one release of the patch version
```

A patch release (for example `patch/0.14.3`) uses the same flow: the integrator cuts it from the
commit of the version being patched, delegates work on task branches, and integrates into the patch
branch instead of a phase branch.

1. **Plan.** Open the tracker and task issues, write the contracts (`docs/design/phase-<n>/`) and
   the ownership map, create `feat/phase-<n>` from `main` and push it.
2. **Dispatch.** Each delegate works in its own worktree, branched from the pushed phase branch, on
   the files its task owns. It commits; it does not push.
   **Never `git stash`:** the stash list is shared by every worktree of the repository, so a
   `stash pop` can apply another delegate's changes and lose your own. For failing-before evidence,
   restore the base file with `git show <base>:<path> > <path>` and put yours back afterwards.
3. **Open a draft PR per task.** When a delegate reports, the integrator runs
   `scripts/open-task-pr.sh <task-branch> <integration-branch> <issue> "<title>"`, where the
   integration branch is `feat/phase-<n>` or `patch/<x.y.z>`. The script refuses `main` and any
   other base. CI runs on the task alone, in parallel with the others; there is no local full-suite
   run per task.
4. **Review and merge into the integration branch.** The integrator reads the diff, checks the
   delegate's evidence, marks the PR ready and merges it once CI is green. Conflicts surface per PR,
   not in one batch. `Closes #` in a PR into a phase or patch branch does not close the issue; the
   release does (`scripts/release/close-issues.mjs`).
5. **Integrate.** After the last task: the phase-level checks that need everything together (browser,
   axe and visual baselines on a fresh seed, reviewed by a person), the independent review, then one
   PR from the phase branch to `main`.
6. **Release** with the release scripts (see `docs/development.md`, “Releasing”).

## Shared files

| File | Rule |
| --- | --- |
| `CHANGELOG.md` | Never edited by a task. Add `changelog.d/<issue>-<slug>.md` instead; the release builds the section. |
| `pnpm-lock.yaml`, `package.json` dependencies | Not changed by a task. Ask the integrator for a dependency; it lands once on the phase branch. |
| Migrations | Only the task the plan names may add one, with the number the plan reserved. |
| Visual baselines, `e2e/visual.spec.ts`, shared test config, generated catalogues | Integrator only. |
| Files outside the task's ownership row | Not edited; report what is needed instead. |

## Tests a delegate runs

- `pnpm test:affected` (or `node scripts/test-affected.mjs --print` to see the selection) for the
  Vitest projects the change touches; the full suite runs in CI.
- `scripts/e2e-docker.sh smoke` for an interface change; `functional` or `axe` when the task's
  contract asks for it. Give each concurrent run its own `TEST_PORT_OFFSET`.
- **The e2e specs share one seeded database across the full suite.** A spec must not assume the seed
  it saw is untouched: other specs create blocks, save broadcast drafts and leave other artifacts
  behind. Assert state-independent facts, or create your own data and clean up after it. Never make
  a test pass only because the seed happened to be fresh.
- Before reporting, run the **full** functional suite (`scripts/e2e-docker.sh functional`), not only
  the specs you added. A green new spec beside a broken existing one is not a green task.
- Run `corepack pnpm lint`, not Biome alone: the root lint also runs the e2e selector check and the
  changelog fragment check. Run the typecheck too.
- **Server tests: only the files for the code the task touches. Never the full server suite.** CI
  runs every server test file on its own ClickHouse for each PR; a full local run on the shared
  stack duplicates that, takes the better part of an hour under load, and pushes the shared
  ClickHouse into `memory limit exceeded` for every other run. A file that fails with that error is
  rerun alone before it counts as a failure.
- All of it against the one shared test stack: `eval "$(scripts/test-services.sh env)"`. A delegate
  never starts its own containers.
- **Never use `TEST_PORT_OFFSET=300`.** Server test port 3473 plus 300 is 3773, the port T3 Code's
  own server listens on in this container, so one test file fails with `EADDRINUSE` on every run.
  Use 400 to 900.

Phase 28 hit both failures directly: **#564** was a broadcast primary action that only looked right
on a fresh seed, and **#566** was an empty block list that another spec had already filled with a
block. Both had passed the narrow spec run and failed in the full functional suite.

## Brief template

```markdown
# Task <letter>: <title> (GitHub issue #<n>)

Start: `git fetch origin && git checkout -B <task-branch> origin/feat/phase-<n>`.

Read: `gh issue view <n>`, `docs/design/phase-<n>/README.md` (your ownership row, shared interfaces),
`docs/design/phase-<n>/<surface>.md`, the mock-up `docs/design/phase-<n>/mock/<surface>.html`.

Implement exactly: <the contract's essentials>.

## Rules
- Edit only the files your ownership row lists, plus new files in your namespace.
- Failing test first; then the fix. No lockfile or dependency changes; no edits to `CHANGELOG.md`
  (add `changelog.d/<n>-<slug>.md`).
- Tests: `pnpm test:affected`, `scripts/e2e-docker.sh smoke` (interface changes), lint, typecheck,
  against the shared stack (`eval "$(scripts/test-services.sh env)"`). No containers of your own.
- Commit on `<task-branch>` (end each commit with the co-author line); do not push.
- Report: branch, SHA, decisions where the contract was silent, evidence with exit codes, and what
  the integrator must do.
- Commit early and often; never end your turn while a background command still runs.
```
